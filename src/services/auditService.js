import { AuditLog } from '../models/index.js';
import { logger } from '../config/logger.js';

/**
 * Append an audit entry. Never throws into the request path; failure is logged loudly.
 * `changes` should be a diff of non-PHI fields, or field names only for PHI.
 */
export async function audit(req, action, entity, entityId, changes, meta) {
  try {
    await AuditLog.create({
      actorId: req?.user?._id,
      actorRole: req?.user?.role,
      action,
      entity,
      entityId: entityId ? String(entityId) : undefined,
      ip: req?.ip,
      userAgent: req?.get?.('user-agent'),
      requestId: req?.id,
      changes,
      meta,
    });
  } catch (err) {
    logger.error({ err, action, entity }, 'AUDIT WRITE FAILED');
  }
}

/** Use when the actor is known but not yet on req (login, password reset). */
export const asActor = (req, user) => ({ ip: req.ip, id: req.id, get: (h) => req.get(h), user });

/** Shallow diff that records which fields changed; values are masked for sensitive keys. */
export function diff(before = {}, after = {}, sensitive = []) {
  const out = {};
  for (const key of Object.keys(after)) {
    const a = JSON.stringify(before?.[key]);
    const b = JSON.stringify(after[key]);
    if (a !== b) out[key] = sensitive.includes(key) ? { changed: true } : { from: before?.[key], to: after[key] };
  }
  return out;
}
