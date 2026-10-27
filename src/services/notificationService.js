import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { Notification, User } from '../models/index.js';
import { emitToUser } from './realtime.js';

let messaging = null;
let fcmInitTried = false;

/** Firebase Admin is optional: when FIREBASE_SERVICE_ACCOUNT_JSON is unset, push is skipped. */
async function getMessaging() {
  if (fcmInitTried) return messaging;
  fcmInitTried = true;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const admin = (await import('firebase-admin')).default;
    const cred = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred) });
    messaging = admin.messaging();
    logger.info('FCM push enabled');
  } catch (err) {
    logger.error({ err }, 'FCM init failed; push disabled');
  }
  return messaging;
}

/**
 * Push payloads deliberately carry no clinical details (lock-screen privacy).
 * `data` must only include IDs; the app fetches details over the authenticated API.
 */
export async function sendPush(userId, { title, body, data = {}, highPriority = false }) {
  const m = await getMessaging();
  if (!m) return;
  const user = await User.findById(userId).select('pushTokens');
  const tokens = (user?.pushTokens || []).map((t) => t.token).filter(Boolean);
  if (!tokens.length) return;
  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  try {
    const res = await m.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
      android: { priority: highPriority ? 'high' : 'normal', ttl: highPriority ? 60_000 : 3_600_000 },
      apns: { headers: { 'apns-priority': highPriority ? '10' : '5' }, payload: { aps: { sound: 'default' } } },
    });
    // Prune tokens FCM reports as invalid
    const bad = res.responses
      .map((r, i) => (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code || '') ? tokens[i] : null))
      .filter(Boolean);
    if (bad.length) await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token: { $in: bad } } } });
  } catch (err) {
    logger.warn({ err }, 'Push send failed');
  }
}

/** Persist + realtime + (optional) push. */
export async function notify(userId, { type, title, body, data, push = true, highPriority = false }) {
  const n = await Notification.create({ userId, type, title, body, data });
  emitToUser(userId, 'notification:new', n.toObject());
  if (push) sendPush(userId, { title, body, data: { type, notificationId: n._id, ...(data || {}) }, highPriority });
  return n;
}
