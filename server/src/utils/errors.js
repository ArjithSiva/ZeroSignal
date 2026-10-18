/** Operational error that is safe to show to the client. */
export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} message safe, user-facing message
   * @param {string} [code] machine-readable code
   * @param {unknown} [details] safe validation details
   */
  constructor(status, message, code = 'ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg = 'Bad request', details) => new AppError(400, msg, 'BAD_REQUEST', details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'You do not have permission to do that') => new AppError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Not found') => new AppError(404, msg, 'NOT_FOUND');
export const conflict = (msg = 'Conflict') => new AppError(409, msg, 'CONFLICT');

/** Wrap an async route so rejections reach the error handler. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
