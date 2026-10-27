import pino from 'pino';
import { env, isTest } from './env.js';

/** Structured JSON logs. PHI and secrets are redacted at the logger level. */
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'homecare-api', env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.newPassword',
      '*.code',
      '*.otp',
      '*.refreshToken',
      '*.accessToken',
      '*.sdp',
      '*.candidate',
      '*.credential',
    ],
    censor: '[redacted]',
  },
});
