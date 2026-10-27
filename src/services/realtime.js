/**
 * Holder for the Socket.IO server plus in-process presence.
 *
 * Presence here is per-instance. For more than one API instance, add the
 * @socket.io/redis-adapter and move presence/call-session maps to Redis.
 * Online presence is NOT clinical availability; routing also requires the doctor's
 * `availability.acceptingConsultations` flag and no active call.
 */
let io = null;
const sockets = new Map(); // userId -> Set(socketId)

export const setIo = (instance) => {
  io = instance;
};
export const getIo = () => io;

export function markOnline(userId, socketId) {
  const k = String(userId);
  if (!sockets.has(k)) sockets.set(k, new Set());
  sockets.get(k).add(socketId);
}
export function markOffline(userId, socketId) {
  const k = String(userId);
  const set = sockets.get(k);
  if (!set) return;
  set.delete(socketId);
  if (!set.size) sockets.delete(k);
}
export const isOnline = (userId) => sockets.has(String(userId));
export const onlineUserIds = () => [...sockets.keys()];

export function emitToUser(userId, event, payload) {
  io?.to(`user:${userId}`).emit(event, payload);
}
export function emitToRole(role, event, payload) {
  io?.to(`role:${role}`).emit(event, payload);
}

/** Lets the signaling layer drop in-memory call state when a consultation closes via REST or timers. */
let callClosedHook = null;
export const setCallClosedHook = (fn) => {
  callClosedHook = fn;
};
export const callClosed = (consultationId) => callClosedHook?.(consultationId);
