import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';

/**
 * Build a limiter. Returns the standard 429 JSON shape used by the error handler.
 * @param {{ windowMs?: number, max: number, message?: string }} o
 */
export function makeLimiter({ windowMs = config.rateLimit.windowMs, max, message = 'Too many requests — slow down and try again shortly.' }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
  });
}

/** Limiters are created per app instance so tests can use tiny windows. */
export function createLimiters(rl = config.rateLimit) {
  return {
    general: makeLimiter({ windowMs: rl.windowMs, max: rl.max }),
    auth: makeLimiter({ windowMs: Math.max(rl.windowMs, 60_000), max: rl.authMax, message: 'Too many sign-in attempts — try again in a minute.' }),
    ai: makeLimiter({ windowMs: rl.windowMs, max: rl.aiMax, message: 'AI rate limit reached — the rule-based fallback is still available.' }),
  };
}
