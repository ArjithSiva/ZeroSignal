import { Router } from 'express';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { z } from 'zod';
import { LANGUAGE_CODES } from '@zerosignal/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, forbidden } from '../utils/errors.js';
import { sanitizeText } from '../utils/sanitize.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(120);
const name = z.string().trim().min(2, 'Enter your name').max(80).transform((s) => sanitizeText(s, 80));
const password = z.string().min(1).max(200);
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');
const location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();
const token = z.string().min(20).max(200);

export const readCookie = (req, key) => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === key) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

/**
 * Cookie-authenticated endpoints (refresh, logout) must carry a custom header. A cross-site page
 * cannot add it without a CORS preflight, which the origin allowlist rejects, so this blocks CSRF
 * independently of SameSite.
 */
export const requireCsrfHeader = (req, _res, next) => (req.get('x-zs-csrf') === '1' ? next() : next(forbidden('Missing request header')));

export function authRoutes({ config, limiters, accounts }) {
  const r = Router();
  const A = config.auth;
  const ctxOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') ?? null });
  const cookieOpts = { httpOnly: true, secure: A.cookieSecure, sameSite: A.cookieSameSite, path: '/api/auth' };

  const setSession = (res, s) => {
    res.cookie(A.cookieName, s.refreshToken, { ...cookieOpts, expires: new Date(s.refreshExpiresAt) });
    const exp = jwt.decode(s.accessToken)?.exp;
    res.set('Cache-Control', 'no-store').json({ token: s.accessToken, expiresAt: exp ? exp * 1000 : null, user: s.user });
  };
  const clearSession = (res) => res.clearCookie(A.cookieName, cookieOpts);

  r.post(
    '/register',
    limiters.auth,
    validate({ body: z.object({ name, email, password, phone: phone.optional(), location: location.optional(), language: z.enum(LANGUAGE_CODES).optional() }) }),
    asyncHandler(async (req, res) => setSession(res.status(201), await accounts.register(req.body, ctxOf(req)))),
  );

  r.post(
    '/login',
    limiters.auth,
    validate({ body: z.object({ email, password, totp: z.string().trim().max(20).optional() }) }),
    asyncHandler(async (req, res) => setSession(res, await accounts.login(req.body, ctxOf(req)))),
  );

  r.post(
    '/refresh',
    requireCsrfHeader,
    asyncHandler(async (req, res) => {
      try {
        setSession(res, await accounts.refresh(readCookie(req, A.cookieName), ctxOf(req)));
      } catch (e) {
        // Only end the session when the server actually refused it. A 503 while MongoDB is still
        // connecting after a Render cold start must NOT delete the cookie and sign the user out.
        if (e?.status === 401) clearSession(res);
        throw e;
      }
    }),
  );

  r.post(
    '/logout',
    requireCsrfHeader,
    asyncHandler(async (req, res) => {
      await accounts.logout(readCookie(req, A.cookieName), ctxOf(req));
      clearSession(res);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/logout-all',
    authenticate,
    asyncHandler(async (req, res) => {
      await accounts.logoutEverywhere(req.user.id, ctxOf(req));
      clearSession(res);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/change-password',
    limiters.auth,
    authenticate,
    validate({ body: z.object({ currentPassword: password, newPassword: password }) }),
    asyncHandler(async (req, res) => setSession(res, await accounts.changePassword(req.user.id, req.body, ctxOf(req)))),
  );

  // Always answers the same way so it cannot be used to find out which emails have accounts.
  r.post(
    '/forgot-password',
    limiters.auth,
    validate({ body: z.object({ email }) }),
    asyncHandler(async (req, res) => {
      await accounts.forgotPassword(req.body.email, ctxOf(req));
      res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
    }),
  );

  r.post(
    '/reset-password',
    limiters.auth,
    validate({ body: z.object({ token, newPassword: password }) }),
    asyncHandler(async (req, res) => {
      await accounts.resetPassword(req.body, ctxOf(req));
      res.json({ ok: true });
    }),
  );

  r.post(
    '/setup-account',
    limiters.auth,
    validate({ body: z.object({ token, newPassword: password }) }),
    asyncHandler(async (req, res) => setSession(res, await accounts.completeInvite(req.body, ctxOf(req)))),
  );

  r.get(
    '/me',
    authenticate,
    asyncHandler(async (req, res) => res.json({ user: await accounts.getUser(req.user.id) })),
  );

  r.patch(
    '/me',
    authenticate,
    validate({ body: z.object({ preferredLanguage: z.enum(LANGUAGE_CODES).optional(), theme: z.enum(['light', 'dark', 'system']).optional(), name: name.optional(), phone: phone.optional() }).refine((b) => Object.keys(b).length > 0, 'Nothing to update') }),
    asyncHandler(async (req, res) => res.json({ user: await accounts.updateProfile(req.user.id, req.body, ctxOf(req)) })),
  );

  // ── two-factor (staff) ──
  r.post(
    '/2fa/setup',
    authenticate,
    asyncHandler(async (req, res) => {
      const s = await accounts.begin2fa(req.user.id);
      res.json({ secret: s.secret, otpauthUri: s.otpauthUri, qr: await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 220 }) });
    }),
  );
  r.post('/2fa/enable', limiters.auth, authenticate, validate({ body: z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }) }), asyncHandler(async (req, res) => res.json(await accounts.enable2fa(req.user.id, req.body.code, ctxOf(req)))));
  r.post('/2fa/disable', limiters.auth, authenticate, validate({ body: z.object({ password, code: z.string().trim().min(6).max(20) }) }), asyncHandler(async (req, res) => {
    await accounts.disable2fa(req.user.id, req.body, ctxOf(req));
    res.json({ ok: true });
  }));

  return r;
}
