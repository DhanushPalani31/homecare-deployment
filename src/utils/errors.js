export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg = 'Bad request', details) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You do not have permission for this action') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg = 'Conflict', code = 'CONFLICT') => new AppError(409, code, msg);
export const tooMany = (msg = 'Too many requests') => new AppError(429, 'TOO_MANY_REQUESTS', msg);

/** Wrap async route handlers (Express 5 forwards rejections, kept for clarity in services). */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
