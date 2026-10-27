import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import mongoose from 'mongoose';
import multer from 'multer';
import { logger } from '../config/logger.js';
import { isProd, isTest } from '../config/env.js';
import { AppError, badRequest } from '../utils/errors.js';

export const requestId = (req, res, next) => {
  req.id = req.get('x-request-id') || randomUUID();
  res.set('x-request-id', req.id);
  next();
};

/** validate({ body, query, params }) with zod schemas; parsed values replace the originals. */
export const validate = (schemas) => (req, _res, next) => {
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const r = schemas[part].safeParse(req[part] ?? {});
    if (!r.success) {
      return next(badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))));
    }
    if (part === 'query') Object.defineProperty(req, 'query', { value: r.data, writable: true, configurable: true });
    else req[part] = r.data;
  }
  next();
};

export const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
export const idParam = z.object({ id: objectId });
export const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(100).optional(),
});

const limiter = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit: isTest ? 10_000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'TOO_MANY_REQUESTS', message } },
  });

export const authLimiter = limiter(15 * 60 * 1000, 20, 'Too many authentication attempts. Try again later.');
// Refresh tokens are 384-bit random values; this limit only stops abuse, not normal reloads.
export const refreshLimiter = limiter(15 * 60 * 1000, 200, 'Too many session refreshes. Try again later.');
export const otpLimiter = limiter(15 * 60 * 1000, 10, 'Too many verification attempts. Try again later.');
export const apiLimiter = limiter(60 * 1000, 300, 'Too many requests');

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = err.status || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message;
  let details = err.details;

  if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid ${err.path}`;
  } else if (err?.code === 11000) {
    status = 409;
    code = 'DUPLICATE';
    message = `Duplicate value for ${Object.keys(err.keyValue || {}).join(', ') || 'unique field'}`;
  } else if (err instanceof multer.MulterError) {
    status = 400;
    code = 'UPLOAD_ERROR';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Malformed JSON body';
  } else if (typeof err.code === 'number') {
    code = 'INTERNAL_ERROR';
  }

  if (status >= 500) {
    logger.error({ err, requestId: req.id, path: req.path }, 'Unhandled error');
    if (isProd) message = 'Something went wrong. Please try again.';
    details = undefined;
  }
  res.status(status).json({ error: { code, message, details, requestId: req.id } });
}
