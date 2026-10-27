import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { env, isProd } from '../config/env.js';
import { Otp, Session, User } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, idParam, otpLimiter, refreshLimiter, validate } from '../middleware/common.js';
import { asActor, audit } from '../services/auditService.js';
import { issueOtp, verifyOtp } from '../services/otpService.js';
import { createSession, revokeAllSessions, revokeSession, rotateRefreshToken } from '../services/tokenService.js';
import { ACCOUNT_STATUS } from '../utils/constants.js';
import { randomToken } from '../utils/crypto.js';
import { badRequest, forbidden, notFound, unauthorized } from '../utils/errors.js';

const router = Router();

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const hashPassword = (pw) => argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword('dummy-password-for-timing-1'));

const deviceSchema = z
  .object({ deviceId: z.string().max(128).optional(), deviceName: z.string().max(128).optional(), platform: z.enum(['ios', 'android', 'web']).optional() })
  .optional();

const identifierSchema = z.string().trim().min(3).max(254);
const findByIdentifier = (identifier) => {
  const v = identifier.trim();
  return v.includes('@') ? User.findOne({ email: v.toLowerCase() }) : User.findOne({ mobile: v });
};
const ctxFrom = (req, device = {}) => ({ ...device, ip: req.ip, userAgent: req.get('user-agent') });

/**
 * Web (admin portal) clients send `X-Client: web` and receive the refresh token as an
 * httpOnly, SameSite=Strict cookie scoped to /api/v1/auth — never readable by JavaScript.
 * Mobile clients receive it in the body and keep it in the Keychain/Keystore.
 */
const RT_COOKIE = 'hc_rt';
const isWeb = (req) => req.get('x-client') === 'web';
function readCookie(req, name) {
  const raw = req.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
function sendTokens(req, res, body) {
  if (isWeb(req) && body.refreshToken) {
    res.cookie(RT_COOKIE, body.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: env.REFRESH_TTL_DAYS * 86400000,
    });
    const { refreshToken, ...rest } = body;
    return res.json(rest);
  }
  return res.json(body);
}
const clearRtCookie = (res) => res.clearCookie(RT_COOKIE, { path: '/api/v1/auth' });

async function issueTokens(req, res, user, device) {
  const { accessToken, refreshToken, session } = await createSession(user, ctxFrom(req, device));
  user.lastLoginAt = new Date();
  await User.updateOne({ _id: user._id }, { lastLoginAt: user.lastLoginAt, failedLoginCount: 0, $unset: { lockUntil: 1 } });
  await audit(asActor(req, user), 'LOGIN', 'Session', session._id, undefined, { platform: device?.platform });
  sendTokens(req, res, { accessToken, refreshToken, sessionId: session._id, user: user.toSafeJSON() });
}

/**
 * @openapi POST /auth/login
 * Login with email or mobile + password. May return an OTP challenge.
 */
router.post(
  '/login',
  authLimiter,
  validate({ body: z.object({ identifier: identifierSchema, password: z.string().min(1).max(128), device: deviceSchema, portal: z.enum(['mobile', 'admin']).optional() }) }),
  async (req, res) => {
    const { identifier, password, device, portal } = req.body;
    const user = await findByIdentifier(identifier).select('+passwordHash +failedLoginCount +lockUntil');
    if (!user) {
      await argon2.verify(await getDummyHash(), password).catch(() => {});
      throw unauthorized('Invalid credentials');
    }
    if (user.lockUntil && user.lockUntil > new Date()) {
      throw unauthorized('Invalid credentials or account temporarily locked. Try again later or reset your password.');
    }
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) {
      const failures = (user.failedLoginCount || 0) + 1;
      const update = { failedLoginCount: failures };
      if (failures >= env.LOGIN_MAX_FAILURES) {
        update.lockUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000);
        update.failedLoginCount = 0;
      }
      await User.updateOne({ _id: user._id }, update);
      await audit(asActor(req, user), 'LOGIN_FAILED', 'User', user._id, undefined, { failures });
      throw unauthorized('Invalid credentials');
    }
    if (user.status !== ACCOUNT_STATUS.ACTIVE) throw forbidden(`Your account is ${user.status.toLowerCase()}. Contact your administrator.`);
    if (portal === 'admin' && user.role !== 'ADMIN') throw forbidden('This portal is for administrators only');

    if (env.OTP_LOGIN_REQUIRED || user.mfaEnabled) {
      const channel = user.mobile ? 'SMS' : 'EMAIL';
      const target = user.mobile || user.email;
      const otp = await issueOtp({ userId: user._id, target, channel, purpose: 'LOGIN', meta: { device } });
      return res.json({ otpRequired: true, challengeId: otp.challengeId, channel, expiresIn: otp.expiresIn, devCode: otp.devCode });
    }
    await issueTokens(req, res, user, device);
  },
);

router.post(
  '/otp/verify',
  otpLimiter,
  validate({ body: z.object({ challengeId: z.string().min(10).max(64), code: z.string().regex(/^\d{6}$/), device: deviceSchema }) }),
  async (req, res) => {
    const otp = await verifyOtp({ challengeId: req.body.challengeId, code: req.body.code, purpose: 'LOGIN' });
    const user = await User.findById(otp.userId);
    if (!user || user.status !== ACCOUNT_STATUS.ACTIVE) throw forbidden('Account is not active');
    await issueTokens(req, res, user, req.body.device || otp.meta?.device);
  },
);

router.post('/otp/resend', otpLimiter, validate({ body: z.object({ challengeId: z.string().min(10).max(64) }) }), async (req, res) => {
  const prev = await Otp.findOne({ challengeId: req.body.challengeId, consumedAt: null });
  if (!prev) throw badRequest('Challenge not found. Start again.');
  const otp = await issueOtp({ userId: prev.userId, target: prev.target, channel: prev.channel, purpose: prev.purpose, meta: prev.meta });
  res.json({ challengeId: otp.challengeId, expiresIn: otp.expiresIn, devCode: otp.devCode });
});

router.post('/refresh', refreshLimiter, validate({ body: z.object({ refreshToken: z.string().min(20).max(200).optional() }) }), async (req, res) => {
  const token = req.body.refreshToken || (isWeb(req) ? readCookie(req, RT_COOKIE) : undefined);
  if (!token) throw unauthorized('No session');
  const result = await rotateRefreshToken(token, async (userId) => {
    const user = await User.findById(userId);
    if (!user || user.status !== ACCOUNT_STATUS.ACTIVE) throw unauthorized('Account is not active');
    return user;
  });
  sendTokens(req, res, { accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user.toSafeJSON() });
});

router.post('/logout', requireAuth, async (req, res) => {
  await revokeSession(req.sessionId, 'LOGOUT');
  const deviceId = req.body?.deviceId;
  if (deviceId) await User.updateOne({ _id: req.user._id }, { $pull: { pushTokens: { deviceId } } });
  await audit(req, 'LOGOUT', 'Session', req.sessionId);
  clearRtCookie(res);
  res.status(204).end();
});

router.post('/logout-all', requireAuth, async (req, res) => {
  await revokeAllSessions(req.user._id, 'LOGOUT_ALL');
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 }, $set: { pushTokens: [] } });
  await audit(req, 'LOGOUT_ALL', 'User', req.user._id);
  clearRtCookie(res);
  res.status(204).end();
});

/* -------- password recovery (responses never reveal whether an account exists) -------- */

router.post('/password/forgot', otpLimiter, validate({ body: z.object({ identifier: identifierSchema }) }), async (req, res) => {
  const user = await findByIdentifier(req.body.identifier);
  if (!user || user.status === ACCOUNT_STATUS.DEACTIVATED) {
    return res.json({ challengeId: randomToken(18), expiresIn: env.OTP_TTL_SECONDS, message: 'If the account exists, a code has been sent.' });
  }
  const isEmail = req.body.identifier.includes('@');
  const otp = await issueOtp({
    userId: user._id,
    target: isEmail ? user.email : user.mobile,
    channel: isEmail ? 'EMAIL' : 'SMS',
    purpose: 'PASSWORD_RESET',
  });
  res.json({ challengeId: otp.challengeId, expiresIn: otp.expiresIn, devCode: otp.devCode, message: 'If the account exists, a code has been sent.' });
});

router.post(
  '/password/reset',
  otpLimiter,
  validate({ body: z.object({ challengeId: z.string().min(10).max(64), code: z.string().regex(/^\d{6}$/), newPassword: passwordSchema }) }),
  async (req, res) => {
    const otp = await verifyOtp({ challengeId: req.body.challengeId, code: req.body.code, purpose: 'PASSWORD_RESET' });
    const passwordHash = await hashPassword(req.body.newPassword);
    await User.updateOne(
      { _id: otp.userId },
      { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, $unset: { lockUntil: 1 }, $inc: { tokenVersion: 1 } },
    );
    await revokeAllSessions(otp.userId, 'PASSWORD_RESET');
    await audit(asActor(req, { _id: otp.userId }), 'PASSWORD_RESET', 'User', otp.userId);
    res.json({ message: 'Password updated. Please sign in.' });
  },
);

router.post(
  '/password/change',
  requireAuth,
  validate({ body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }) }),
  async (req, res) => {
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await argon2.verify(user.passwordHash, req.body.currentPassword))) throw badRequest('Current password is incorrect');
    if (req.body.currentPassword === req.body.newPassword) throw badRequest('New password must be different');
    user.passwordHash = await hashPassword(req.body.newPassword);
    user.passwordChangedAt = new Date();
    await user.save();
    await revokeAllSessions(user._id, 'PASSWORD_CHANGED', req.sessionId); // keep this device signed in
    await audit(req, 'PASSWORD_CHANGE', 'User', user._id);
    res.json({ message: 'Password changed. Other devices have been signed out.' });
  },
);

/* ----------------------------------------- device / session management ---------------- */

router.get('/sessions', requireAuth, async (req, res) => {
  const sessions = await Session.find({ userId: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } })
    .select('deviceName platform ip userAgent createdAt lastUsedAt')
    .sort({ lastUsedAt: -1 });
  res.json({ data: sessions.map((s) => ({ ...s.toObject(), current: s._id.equals(req.sessionId) })) });
});

router.delete('/sessions/:id', requireAuth, validate({ params: idParam }), async (req, res) => {
  const s = await Session.findOne({ _id: req.params.id, userId: req.user._id });
  if (!s) throw notFound('Session not found');
  await revokeSession(s._id, 'REVOKED_BY_USER');
  await audit(req, 'SESSION_REVOKE', 'Session', s._id);
  res.status(204).end();
});

export default router;
