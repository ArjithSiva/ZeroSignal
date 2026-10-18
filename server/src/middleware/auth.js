import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { forbidden, unauthorized } from '../utils/errors.js';

/** @typedef {{ id: string, role: 'admin'|'broadcaster'|'receiver', name: string, email: string }} AuthUser */

/** @param {{ _id: unknown, role: string, name: string, email: string }} user */
export function signToken(user, cfg = config) {
  return jwt.sign({ sub: String(user._id), role: user.role, name: user.name, email: user.email }, cfg.jwtSecret, {
    expiresIn: cfg.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

/**
 * Verify a JWT. Returns the AuthUser or throws a 401 AppError.
 * Algorithm is pinned to HS256 so `alg: none` and key-confusion tokens are rejected.
 * @returns {AuthUser}
 */
export function verifyToken(token, cfg = config) {
  try {
    const p = jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'] });
    return { id: p.sub, role: p.role, name: p.name, email: p.email };
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

export function tokenFromHeader(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** Require a valid JWT. Sets `req.user`. */
export function authenticate(req, _res, next) {
  try {
    const token = tokenFromHeader(req);
    if (!token) throw unauthorized();
    // The app's injected config wins (tests, staging); falls back to the process config.
    req.user = verifyToken(token, req.app?.locals?.config ?? config);
    next();
  } catch (e) {
    next(e);
  }
}

/** Require one of the given roles (use after `authenticate`). */
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};
