import { Server } from 'socket.io';
import { z } from 'zod';
import mongoose from 'mongoose';
import { corsOrigins, env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { authenticateToken } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
import {
  acceptConsultation, cancelConsultation, createConsultation, declineConsultation, endCall, getConsultationForUser,
  markCallConnected, recordReconnect,
} from '../services/consultationService.js';
import { markOffline, markOnline, setCallClosedHook, setIo } from '../services/realtime.js';
import { buildIceServers } from '../services/turnService.js';
import { ACCOUNT_STATUS, CONSULT_STATUS, ROLES, URGENCY } from '../utils/constants.js';
import { Session, User } from '../models/index.js';

/**
 * Call sessions (in-process). For horizontal scaling, use the Redis adapter and
 * sticky sessions, or move this map to Redis keyed by consultationId.
 *   consultationId -> { nurseId, doctorId, sockets: Map(userId -> socketId), negotiationId, graceTimers: Map(userId -> timeout) }
 */
const calls = new Map();

const oid = z.string().refine((v) => mongoose.isValidObjectId(v), 'invalid id');
const schemas = {
  request: z.object({
    patientId: oid,
    visitId: oid.optional(),
    doctorId: oid.optional(),
    parentConsultationId: oid.optional(),
    reason: z.string().trim().min(5).max(1000),
    urgency: z.enum(Object.values(URGENCY)),
    observations: z.string().max(3000).optional(),
    audioOnly: z.boolean().optional(),
    consent: z.object({ obtained: z.boolean(), method: z.enum(['VERBAL', 'WRITTEN', 'IN_APP']).optional() }).optional(),
  }),
  byId: z.object({ consultationId: oid, reason: z.string().max(300).optional() }),
  sdp: z.object({
    consultationId: oid,
    negotiationId: z.number().int().min(1),
    description: z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(10).max(30000) }),
  }),
  ice: z.object({
    consultationId: oid,
    negotiationId: z.number().int().min(1),
    candidate: z.object({
      candidate: z.string().max(1000),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }),
  }),
  media: z.object({ consultationId: oid, audio: z.boolean(), video: z.boolean() }),
};

/** Wrap a handler: validate payload, run, reply via ack with {ok, ...} or {ok:false, error}. */
function handler(socket, schema, fn) {
  return async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowEvent(socket)) return reply({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many events' } });
    const parsed = schema ? schema.safeParse(payload ?? {}) : { success: true, data: payload };
    if (!parsed.success) return reply({ ok: false, error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message } });
    try {
      const result = await fn(parsed.data);
      reply({ ok: true, ...(result || {}) });
    } catch (err) {
      if (!err.status || err.status >= 500) logger.error({ err, userId: String(socket.data.user._id) }, 'socket handler error');
      reply({ ok: false, error: { code: err.code || 'ERROR', message: err.status && err.status < 500 ? err.message : 'Unexpected error' } });
    }
  };
}

/** Simple per-socket rate limit: 80 events / second (ICE trickle can burst). */
function allowEvent(socket) {
  const now = Date.now();
  const b = (socket.data.bucket ??= { t: now, n: 0 });
  if (now - b.t > 1000) {
    b.t = now;
    b.n = 0;
  }
  b.n += 1;
  return b.n <= 80;
}

const peerOf = (call, userId) => (String(call.nurseId) === String(userId) ? String(call.doctorId) : String(call.nurseId));

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigins, credentials: true },
    pingInterval: 10000,
    pingTimeout: 8000,
    maxHttpBufferSize: 64 * 1024,
    connectionStateRecovery: { maxDisconnectionDuration: 30_000, skipMiddlewares: false },
  });
  setIo(io);
  setCallClosedHook((consultationId) => cleanupCall(io, String(consultationId)));

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace(/^Bearer /, '');
      const { user, sessionId } = await authenticateToken(token);
      socket.data.user = user;
      socket.data.sessionId = sessionId;
      next();
    } catch (err) {
      next(Object.assign(new Error(err.message || 'unauthorized'), { data: { code: err.code || 'UNAUTHORIZED' } }));
    }
  });

  // Re-validate sessions periodically: suspended users or revoked sessions are disconnected,
  // independent of access-token expiry (which only matters at connect time).
  const recheck = setInterval(async () => {
    for (const [, socket] of io.of('/').sockets) {
      try {
        const [u, s] = await Promise.all([User.findById(socket.data.user._id), Session.findById(socket.data.sessionId).select('revokedAt expiresAt')]);
        const ok = u && u.status === ACCOUNT_STATUS.ACTIVE && s && !s.revokedAt && s.expiresAt > new Date() && (u.tokenVersion ?? 0) === (socket.data.user.tokenVersion ?? 0);
        if (!ok) {
          socket.emit('auth:revoked', { reason: 'Session ended' });
          socket.disconnect(true);
        } else socket.data.user = u;
      } catch (err) {
        logger.warn({ err }, 'socket recheck failed');
      }
    }
  }, 60_000);
  recheck.unref();

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const uid = String(user._id);
    socket.join(`user:${uid}`);
    socket.join(`role:${user.role}`);
    markOnline(uid, socket.id);
    logger.debug({ uid, role: user.role }, 'socket connected');
    if (user.role === ROLES.ADMIN) io.to(`role:${ROLES.ADMIN}`).emit('presence:changed', {});
    else io.to(`role:${ROLES.ADMIN}`).emit('presence:changed', { userId: uid, online: true });

    // Rejoin any call this user was in (app restart / network switch)
    for (const [cid, call] of calls) {
      if ((String(call.nurseId) === uid || String(call.doctorId) === uid) && call.graceTimers.has(uid)) {
        socket.emit('call:resume-available', { consultationId: cid });
      }
    }

    socket.on('auth:refresh', handler(socket, z.object({ token: z.string().min(20) }), async ({ token }) => {
      const { user: fresh } = await authenticateToken(token);
      if (!fresh._id.equals(user._id)) throw Object.assign(new Error('Token belongs to another user'), { status: 403, code: 'FORBIDDEN' });
      socket.data.token = token;
      socket.data.user = fresh;
    }));

    /* ---------------- consultation lifecycle over socket (mirrors REST) ---------------- */

    socket.on('consultation:request', handler(socket, schemas.request, async (data) => {
      const consultation = await createConsultation(socket.data.user, data);
      await audit(sockReq(socket), 'CONSULT_REQUEST', 'Consultation', consultation._id, undefined, { via: 'socket' });
      return { consultation };
    }));
    socket.on('consultation:accept', handler(socket, schemas.byId, async ({ consultationId }) => {
      requireRole(socket, ROLES.DOCTOR);
      const consultation = await acceptConsultation(socket.data.user, consultationId);
      await audit(sockReq(socket), 'CONSULT_ACCEPT', 'Consultation', consultationId, undefined, { via: 'socket' });
      return { consultation };
    }));
    socket.on('consultation:decline', handler(socket, schemas.byId, async ({ consultationId, reason }) => {
      requireRole(socket, ROLES.DOCTOR);
      const consultation = await declineConsultation(socket.data.user, consultationId, reason);
      await audit(sockReq(socket), 'CONSULT_DECLINE', 'Consultation', consultationId, undefined, { via: 'socket' });
      return { consultation };
    }));
    socket.on('consultation:cancel', handler(socket, schemas.byId, async ({ consultationId, reason }) => {
      requireRole(socket, ROLES.NURSE);
      const consultation = await cancelConsultation(socket.data.user, consultationId, reason || 'CANCELLED_BY_NURSE');
      cleanupCall(io, consultationId);
      return { consultation };
    }));

    /* ---------------- call room ---------------- */

    socket.on('call:join', handler(socket, schemas.byId, async ({ consultationId }) => {
      const c = await getConsultationForUser(socket.data.user, consultationId);
      const isNurse = c.nurseId.equals(user._id);
      const isDoctor = c.doctorId?.equals(user._id);
      if (!isNurse && !isDoctor) throw Object.assign(new Error('Not a participant'), { status: 403, code: 'FORBIDDEN' });
      if (![CONSULT_STATUS.ACCEPTED, CONSULT_STATUS.IN_CALL].includes(c.status)) {
        throw Object.assign(new Error(`Consultation is ${c.status.toLowerCase()}`), { status: 409, code: 'CALL_NOT_ACTIVE' });
      }
      let call = calls.get(consultationId);
      if (!call) {
        call = { nurseId: String(c.nurseId), doctorId: String(c.doctorId), sockets: new Map(), negotiationId: 0, graceTimers: new Map(), connectedOnce: c.status === CONSULT_STATUS.IN_CALL };
        calls.set(consultationId, call);
      }
      // Only one device per participant: the newest join wins.
      const prev = call.sockets.get(uid);
      if (prev && prev !== socket.id) {
        io.to(prev).emit('call:replaced', { consultationId });
        io.sockets.sockets.get(prev)?.leave(`consult:${consultationId}`);
      }
      const grace = call.graceTimers.get(uid);
      if (grace) {
        clearTimeout(grace);
        call.graceTimers.delete(uid);
      }
      call.sockets.set(uid, socket.id);
      socket.join(`consult:${consultationId}`);
      (socket.data.calls ??= new Set()).add(consultationId);

      const peerPresent = call.sockets.has(peerOf(call, uid));
      if (peerPresent) startNegotiation(io, consultationId, call, false);
      else io.to(`user:${peerOf(call, uid)}`).emit('call:peer-waiting', { consultationId });
      return {
        role: isNurse ? 'nurse' : 'doctor',
        isOfferer: isNurse, // the nurse always creates offers: avoids glare/duplicate offers
        peerPresent,
        audioOnly: c.audioOnly,
        ...buildIceServers(user._id),
      };
    }));

    socket.on('webrtc:offer', handler(socket, schemas.sdp, async (d) => relaySdp(io, socket, d, 'offer')));
    socket.on('webrtc:answer', handler(socket, schemas.sdp, async (d) => relaySdp(io, socket, d, 'answer')));

    socket.on('webrtc:ice-candidate', handler(socket, schemas.ice, async ({ consultationId, negotiationId, candidate }) => {
      const call = memberCall(socket, consultationId);
      if (negotiationId !== call.negotiationId) return { dropped: 'STALE_NEGOTIATION' };
      const peerSocket = call.sockets.get(peerOf(call, uid));
      if (!peerSocket) return { dropped: 'PEER_ABSENT' };
      io.to(peerSocket).emit('webrtc:ice-candidate', { consultationId, negotiationId, candidate });
    }));

    socket.on('call:connected', handler(socket, schemas.byId, async ({ consultationId }) => {
      const call = memberCall(socket, consultationId);
      if (!call.connectedOnce) {
        call.connectedOnce = true;
        const c = await markCallConnected(consultationId);
        io.to(`consult:${consultationId}`).emit('call:connected', { consultationId, startedAt: c?.startedAt });
        return { startedAt: c?.startedAt };
      }
    }));

    /** ICE restart / renegotiation request (network change, ICE failed). */
    socket.on('call:reconnect', handler(socket, schemas.byId, async ({ consultationId }) => {
      const call = memberCall(socket, consultationId);
      if (!call.sockets.has(peerOf(call, uid))) return { waitingForPeer: true };
      await recordReconnect(consultationId);
      startNegotiation(io, consultationId, call, true);
    }));

    socket.on('call:media-state', handler(socket, schemas.media, async ({ consultationId, audio, video }) => {
      const call = memberCall(socket, consultationId);
      const peerSocket = call.sockets.get(peerOf(call, uid));
      if (peerSocket) io.to(peerSocket).emit('call:media-state', { consultationId, audio, video });
    }));

    socket.on('call:end', handler(socket, schemas.byId, async ({ consultationId, reason }) => {
      const consultation = await endCall(socket.data.user, consultationId, { reason: reason || 'ENDED' });
      await audit(sockReq(socket), 'CONSULT_END', 'Consultation', consultationId, undefined, { status: consultation.status, durationSeconds: consultation.durationSeconds });
      cleanupCall(io, consultationId);
      return { consultation };
    }));

    socket.on('call:failed', handler(socket, schemas.byId, async ({ consultationId, reason }) => {
      const consultation = await endCall(socket.data.user, consultationId, { reason: reason || 'MEDIA_FAILURE', failed: true });
      await audit(sockReq(socket), 'CONSULT_FAILED', 'Consultation', consultationId, undefined, { reason });
      cleanupCall(io, consultationId);
      return { consultation };
    }));

    socket.on('disconnect', (why) => {
      markOffline(uid, socket.id);
      io.to(`role:${ROLES.ADMIN}`).emit('presence:changed', { userId: uid, online: false });
      for (const cid of socket.data.calls || []) {
        const call = calls.get(cid);
        if (!call || call.sockets.get(uid) !== socket.id) continue;
        call.sockets.delete(uid);
        const peerSocket = call.sockets.get(peerOf(call, uid));
        if (peerSocket) io.to(peerSocket).emit('call:peer-left', { consultationId: cid, graceSeconds: env.CALL_RECONNECT_GRACE_SECONDS });
        // If the participant doesn't come back within the grace period, close the consultation.
        const t = setTimeout(async () => {
          call.graceTimers.delete(uid);
          if (call.sockets.has(uid)) return;
          try {
            await endCall({ _id: new mongoose.Types.ObjectId(uid), role: user.role }, cid, { reason: 'CONNECTION_LOST', failed: !call.connectedOnce });
          } catch (err) {
            logger.warn({ err }, 'grace end failed');
          }
          cleanupCall(io, cid);
        }, env.CALL_RECONNECT_GRACE_SECONDS * 1000);
        t.unref?.();
        call.graceTimers.set(uid, t);
      }
      logger.debug({ uid, why }, 'socket disconnected');
    });
  });

  return io;
}

function requireRole(socket, role) {
  if (socket.data.user.role !== role) throw Object.assign(new Error('Forbidden'), { status: 403, code: 'FORBIDDEN' });
}

/** Sender must be a joined participant of this consultation's call room. */
function memberCall(socket, consultationId) {
  const call = calls.get(consultationId);
  const uid = String(socket.data.user._id);
  if (!call || call.sockets.get(uid) !== socket.id) {
    throw Object.assign(new Error('Join the call first'), { status: 403, code: 'NOT_IN_CALL' });
  }
  return call;
}

function startNegotiation(io, consultationId, call, iceRestart) {
  call.negotiationId += 1;
  io.to(`consult:${consultationId}`).emit('call:ready', {
    consultationId,
    negotiationId: call.negotiationId,
    offererId: call.nurseId,
    iceRestart,
  });
}

function relaySdp(io, socket, { consultationId, negotiationId, description }, kind) {
  const call = memberCall(socket, consultationId);
  const uid = String(socket.data.user._id);
  if (description.type !== kind) throw Object.assign(new Error('Description type mismatch'), { status: 400, code: 'BAD_REQUEST' });
  // Only the nurse offers, only the doctor answers — prevents glare and duplicate offers.
  if (kind === 'offer' && uid !== call.nurseId) throw Object.assign(new Error('Only the caller may send offers'), { status: 403, code: 'FORBIDDEN' });
  if (kind === 'answer' && uid !== call.doctorId) throw Object.assign(new Error('Only the callee may answer'), { status: 403, code: 'FORBIDDEN' });
  if (negotiationId !== call.negotiationId) return { dropped: 'STALE_NEGOTIATION' };
  const peerSocket = call.sockets.get(peerOf(call, uid));
  if (!peerSocket) return { dropped: 'PEER_ABSENT' };
  io.to(peerSocket).emit(`webrtc:${kind}`, { consultationId, negotiationId, description });
  return {};
}

function cleanupCall(io, consultationId) {
  const call = calls.get(consultationId);
  if (!call) return;
  for (const t of call.graceTimers.values()) clearTimeout(t);
  io.in(`consult:${consultationId}`).socketsLeave(`consult:${consultationId}`);
  calls.delete(consultationId);
}

/** Minimal req-like object so the audit service can record socket actions. */
const sockReq = (socket) => ({
  user: socket.data.user,
  ip: socket.handshake.address,
  id: socket.id,
  get: (h) => socket.handshake.headers[h.toLowerCase()],
});

export const _test = { calls };
