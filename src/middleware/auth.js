import { User, Session } from '../models/index.js';
import { ACCOUNT_STATUS } from '../utils/constants.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import { verifyAccessToken } from '../services/tokenService.js';

/**
 * Resolve the authenticated principal from a bearer token.
 * Shared by HTTP and Socket.IO so both enforce identical rules:
 * valid signature, live session, active account, current token version.
 */
export async function authenticateToken(token) {
  if (!token) throw unauthorized();
  const claims = verifyAccessToken(token);
  const [user, session] = await Promise.all([
    User.findById(claims.sub),
    Session.findById(claims.sid).select('revokedAt expiresAt userId'),
  ]);
  if (!user || !session || !session.userId.equals(user._id)) throw unauthorized();
  if (session.revokedAt || session.expiresAt < new Date()) throw unauthorized('Session has ended');
  if ((user.tokenVersion ?? 0) !== claims.tv) throw unauthorized('Session has been invalidated');
  if (user.status !== ACCOUNT_STATUS.ACTIVE) throw forbidden(`Account is ${user.status.toLowerCase()}`);
  // Role always comes from the database, never from client input or a stale token claim.
  return { user, sessionId: session._id };
}

export async function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const { user, sessionId } = await authenticateToken(token);
  req.user = user;
  req.sessionId = sessionId;
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};
