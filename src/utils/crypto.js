import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const hmac = (secret, value, algo = 'sha256', enc = 'hex') =>
  crypto.createHmac(algo, secret).update(value).digest(enc);

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** 6-digit numeric OTP from a CSPRNG. */
export const numericOtp = (digits = 6) =>
  crypto.randomInt(0, 10 ** digits).toString().padStart(digits, '0');
