import { env, isProd } from '../config/env.js';
import { logger } from '../config/logger.js';
import { Otp } from '../models/index.js';
import { hmac, numericOtp, randomToken, timingSafeEqualStr } from '../utils/crypto.js';
import { badRequest, tooMany } from '../utils/errors.js';

/**
 * Delivery is pluggable. In development the code is logged (and optionally returned to
 * the client when EXPOSE_DEV_OTP=true, which is refused in staging/production).
 * Replace `deliver` with your SMS / email provider integration.
 */
async function deliver({ channel, target, code, purpose }) {
  if (!isProd) {
    logger.info({ channel, target, purpose, devCode: code }, 'OTP issued (dev delivery)');
    return;
  }
  // TODO: integrate provider (e.g. SMS gateway / transactional email). Never log the code in prod.
  logger.info({ channel, purpose }, 'OTP dispatched');
}

const codeHash = (challengeId, code) => hmac(env.OTP_HMAC_SECRET, `${challengeId}:${code}`);

export async function issueOtp({ userId, target, channel, purpose, meta }) {
  const last = await Otp.findOne({ target, purpose }).sort({ createdAt: -1 });
  if (last && Date.now() - last.createdAt.getTime() < env.OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    throw tooMany('Please wait before requesting another code');
  }
  // Cap issuance per target per hour
  const hourly = await Otp.countDocuments({ target, purpose, createdAt: { $gt: new Date(Date.now() - 3600_000) } });
  if (hourly >= 5) throw tooMany('Too many codes requested. Try again later.');

  const code = numericOtp(6);
  const challengeId = randomToken(18);
  await Otp.create({
    challengeId,
    userId,
    target,
    channel,
    purpose,
    codeHash: codeHash(challengeId, code),
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    expiresAt: new Date(Date.now() + env.OTP_TTL_SECONDS * 1000),
    meta,
  });
  await deliver({ channel, target, code, purpose });
  return { challengeId, expiresIn: env.OTP_TTL_SECONDS, devCode: env.EXPOSE_DEV_OTP && !isProd ? code : undefined };
}

/** Verifies and consumes a challenge. Returns the OTP document on success. */
export async function verifyOtp({ challengeId, code, purpose }) {
  const otp = await Otp.findOne({ challengeId, purpose });
  if (!otp || otp.consumedAt) throw badRequest('Invalid or expired code');
  if (otp.expiresAt < new Date()) throw badRequest('Code has expired');
  if (otp.attempts >= otp.maxAttempts) throw tooMany('Too many incorrect attempts. Request a new code.');

  // Count the attempt before comparing so parallel guesses can't exceed the limit.
  const counted = await Otp.findOneAndUpdate(
    { _id: otp._id, attempts: { $lt: otp.maxAttempts }, consumedAt: null },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!counted) throw tooMany('Too many incorrect attempts. Request a new code.');
  if (!timingSafeEqualStr(codeHash(challengeId, String(code)), otp.codeHash)) {
    throw badRequest('Incorrect code');
  }
  const consumed = await Otp.findOneAndUpdate({ _id: otp._id, consumedAt: null }, { consumedAt: new Date() });
  if (!consumed) throw badRequest('Invalid or expired code');
  return otp;
}
