import { env } from '../config/env.js';
import { hmac } from '../utils/crypto.js';

/**
 * Builds the ICE server list for a participant.
 *
 * TURN uses the coturn "TURN REST API" scheme (`use-auth-secret` + `static-auth-secret`):
 *   username   = "<unix-expiry>:<userId>"
 *   credential = base64(HMAC-SHA1(static-auth-secret, username))
 * The shared secret never leaves the server and credentials expire after
 * TURN_CREDENTIAL_TTL_SECONDS, so nothing permanent is shipped in the mobile app.
 */
export function buildIceServers(userId) {
  const servers = [];
  const stun = env.STUN_URLS.split(',').map((s) => s.trim()).filter(Boolean);
  if (stun.length) servers.push({ urls: stun });

  const turn = env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean);
  let expiresAt = null;
  if (turn.length && env.TURN_STATIC_AUTH_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + env.TURN_CREDENTIAL_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = hmac(env.TURN_STATIC_AUTH_SECRET, username, 'sha1', 'base64');
    servers.push({ urls: turn, username, credential });
    expiresAt = new Date(expiry * 1000).toISOString();
  }
  return { iceServers: servers, expiresAt, turnConfigured: Boolean(expiresAt) };
}
