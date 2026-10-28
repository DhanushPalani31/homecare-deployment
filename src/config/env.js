import 'dotenv/config';
import { z } from 'zod';

/**
 * All environment-specific values come from process.env.
 * The process refuses to start in staging/production if a secret is missing
 * or still set to a development placeholder.
 */
const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/homecare_dev'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().default(0),

  JWT_ACCESS_SECRET: z.string().min(32).default('dev-only-access-secret-change-me-0123456789'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_ISSUER: z.string().default('homecare-api'),
  JWT_AUDIENCE: z.string().default('homecare-clients'),
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
  REFRESH_IDLE_DAYS: z.coerce.number().default(7),

  OTP_LOGIN_REQUIRED: bool(false),
  OTP_TTL_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().default(60),
  OTP_HMAC_SECRET: z.string().min(32).default('dev-only-otp-hmac-secret-change-me-0123456'),

  LOGIN_MAX_FAILURES: z.coerce.number().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().default(15),

  STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  REQUIRE_TURN: bool(false),
  TURN_URLS: z.string().default(''),
  TURN_STATIC_AUTH_SECRET: z.string().default(''),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().default(3600),

  CONSULT_RING_TIMEOUT_SECONDS: z.coerce.number().default(60),
  CONSULT_MAX_ESCALATIONS: z.coerce.number().default(3),
  CALL_RECONNECT_GRACE_SECONDS: z.coerce.number().default(45),

  UPLOAD_DIR: z.string().default('./uploads'),
  UPLOAD_MAX_MB: z.coerce.number().default(15),

  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  EXPOSE_DEV_OTP: bool(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = ['staging', 'production'].includes(env.NODE_ENV);
export const isTest = env.NODE_ENV === 'test';

if (isProd) {
  const problems = [];
  if (env.JWT_ACCESS_SECRET.startsWith('dev-only')) problems.push('JWT_ACCESS_SECRET');
  if (env.OTP_HMAC_SECRET.startsWith('dev-only')) problems.push('OTP_HMAC_SECRET');
  if (env.REQUIRE_TURN && !env.TURN_URLS) problems.push('TURN_URLS (required when REQUIRE_TURN=true)');
  if (env.REQUIRE_TURN && !env.TURN_STATIC_AUTH_SECRET) problems.push('TURN_STATIC_AUTH_SECRET');
  if (env.EXPOSE_DEV_OTP) problems.push('EXPOSE_DEV_OTP must be false');
  if (problems.length) {
    console.error(`Refusing to start in ${env.NODE_ENV}: fix ${problems.join(', ')}`);
    process.exit(1);
  }
}

export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
