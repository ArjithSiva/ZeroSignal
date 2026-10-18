import { config } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, `Route not found: ${req.method} ${req.path}`, 'NOT_FOUND'));
}

/**
 * Central error handler. Never leaks stack traces, driver messages or secrets in production;
 * unknown errors are reported as a generic 500 and logged server-side only.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const cfg = req.app?.locals?.config ?? config;
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } });
  }
  if (err?.name === 'CastError' || err?.name === 'ValidationError') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid request data' } });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: { code: 'CONFLICT', message: 'Duplicate record' } });
  }
  if (err?.message === 'CORS_NOT_ALLOWED') {
    return res.status(403).json({ error: { code: 'CORS', message: 'Origin not allowed' } });
  }

  if (
    (err?.name === 'MongooseError' && /buffering timed out/i.test(err.message ?? '')) ||
    err?.name === 'MongooseServerSelectionError' ||
    err?.name === 'MongoServerSelectionError'
  ) {
    return res.status(503).json({ error: { code: 'DB_UNAVAILABLE', message: 'The database is not connected yet. Try again in a few seconds.' } });
  }

  if (!cfg.isTest) console.error('[error]', err);
  const body = { error: { code: 'INTERNAL', message: 'Something went wrong on our side.' } };
  if (!cfg.isProd) body.error.debug = String(err?.message ?? err);
  res.status(500).json(body);
}
