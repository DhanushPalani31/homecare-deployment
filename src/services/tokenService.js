import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Session } from '../models/index.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { unauthorized } from '../utils/errors.js';
import { logger } from '../config/logger.js';

const DAY = 24 * 60 * 60 * 1000;

export function signAccessToken(user, sessionId) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, sid: String(sessionId), tv: user.tokenVersion ?? 0 },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL, issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, algorithm: 'HS256' },
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

/** Create a new device session and return the opaque refresh token (only shown once). */
export async function createSession(user, ctx = {}) {
  const refreshToken = randomToken(48);
  const session = await Session.create({
    userId: user._id,
    familyId: randomToken(16),
    tokenHash: sha256(refreshToken),
    deviceId: ctx.deviceId,
    deviceName: ctx.deviceName,
    platform: ctx.platform,
    userAgent: ctx.userAgent,
    ip: ctx.ip,
    expiresAt: new Date(Date.now() + env.REFRESH_TTL_DAYS * DAY),
  });
  return { session, refreshToken, accessToken: signAccessToken(user, session._id) };
}

/**
 * Rotate a refresh token. Reuse of an already-rotated token is treated as theft:
 * the entire session family is revoked and the caller must log in again.
 */
export async function rotateRefreshToken(refreshToken, loadUser) {
  const hash = sha256(refreshToken);
  const session = await Session.findOne({ tokenHash: hash });

  if (!session) {
    const reused = await Session.findOne({ previousHashes: hash });
    if (reused) {
      await Session.updateMany(
        { familyId: reused.familyId, revokedAt: null },
        { revokedAt: new Date(), revokedReason: 'REFRESH_TOKEN_REUSE' },
      );
      logger.warn({ userId: String(reused.userId), sessionId: String(reused._id) }, 'Refresh token reuse detected; session revoked');
    }
    throw unauthorized('Session is no longer valid. Please sign in again.');
  }
  if (session.revokedAt) throw unauthorized('Session has been signed out');
  const now = Date.now();
  if (session.expiresAt.getTime() < now) throw unauthorized('Session expired');
  if (now - session.lastUsedAt.getTime() > env.REFRESH_IDLE_DAYS * DAY) {
    session.revokedAt = new Date();
    session.revokedReason = 'IDLE_TIMEOUT';
    await session.save();
    throw unauthorized('Session expired due to inactivity');
  }

  const user = await loadUser(session.userId);
  const next = randomToken(48);
  // Atomic compare-and-swap so two concurrent refreshes with the same token cannot both succeed.
  const updated = await Session.findOneAndUpdate(
    { _id: session._id, tokenHash: hash, revokedAt: null },
    { $set: { tokenHash: sha256(next), lastUsedAt: new Date() }, $push: { previousHashes: { $each: [hash], $slice: -20 } } },
    { returnDocument: 'after' },
  );
  if (!updated) throw unauthorized('Session is no longer valid. Please sign in again.');
  return { user, session: updated, refreshToken: next, accessToken: signAccessToken(user, updated._id) };
}

export async function revokeSession(sessionId, reason = 'LOGOUT') {
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });
}

export async function revokeAllSessions(userId, reason = 'LOGOUT_ALL', exceptSessionId) {
  const q = { userId, revokedAt: null };
  if (exceptSessionId) q._id = { $ne: exceptSessionId };
  await Session.updateMany(q, { revokedAt: new Date(), revokedReason: reason });
}
