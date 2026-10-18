import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import { Broadcast } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { idParam, validate } from '../middleware/validate.js';
import { verifyHls } from '../services/media/rooms.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';

const defaultLoad = async (id) => {
  const b = await Broadcast.findById(id);
  return b ? { id: String(b._id), status: b.status, createdBy: b.createdBy ? String(b.createdBy) : null } : null;
};

/**
 * /api/media — scoped credentials for real streaming.
 *   GET  /config                 which providers exist here (no secrets)
 *   POST /:id/publish-token      broadcaster/admin who OWNS the broadcast: publish-only credentials
 *   POST /:id/view-token         any signed-in user: subscribe-only credentials for every available provider
 *   POST /:id/hls/start|stop     owner: run / stop the server-side HLS ladder
 *   GET  /:id/status
 * Media is optional and never gates alerts. Credentials are short-lived and bound to an unguessable room.
 */
export function mediaRoutes({ media, loadBroadcast = defaultLoad, audit = () => {} }) {
  const r = Router();
  r.use(authenticate);

  const load = async (id) => {
    const b = await loadBroadcast(id);
    if (!b) throw notFound('Broadcast not found');
    return b;
  };
  const mustOwn = (req, b) => {
    if (req.user.role !== 'admin' && b.createdBy !== req.user.id) throw forbidden('Only the broadcast owner or an admin can do that');
  };

  r.get('/config', (_req, res) => res.json(media.describe()));

  r.post(
    '/:id/publish-token',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam, body: z.object({ provider: z.enum(['livekit']).default('livekit') }) }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      mustOwn(req, b);
      const creds = await media.publish({ broadcast: b, user: req.user, provider: req.body.provider });
      if (!creds) throw conflict(`${req.body.provider} is not configured on this server`);
      audit('MEDIA_PUBLISH_TOKEN', req, { targetId: b.id });
      res.json(creds);
    }),
  );

  r.post(
    '/:id/view-token',
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      res.json({ ...(await media.view({ broadcast: b, user: req.user })), live: b.status === 'LIVE' });
    }),
  );

  r.post(
    '/:id/hls/start',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam, body: z.object({ kind: z.enum(['pattern', 'file', 'url']).default('pattern'), source: z.string().trim().max(500).optional() }) }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      mustOwn(req, b);
      const { kind, source } = req.body;
      // A URL source is read by FFmpeg on the server, so only network protocols are allowed (no file:, no concat, no local paths).
      if (kind === 'url' && !/^(https?|rtmps?|rtsp|srt):\/\//i.test(source ?? '')) throw badRequest('A URL source must start with http(s)://, rtmp(s)://, rtsp:// or srt://');
      if (kind === 'file' && source) throw badRequest('A file source is configured by the server operator (HLS_SOURCE_FILE), not chosen by clients');
      try {
        const job = await media.startHls({ broadcast: b, kind, source });
        audit('MEDIA_HLS_START', req, { targetId: b.id, meta: { kind } });
        res.json({ status: job.status, kind: job.kind });
      } catch (e) {
        throw conflict(e.message);
      }
    }),
  );

  r.post(
    '/:id/hls/stop',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      mustOwn(req, b);
      await media.onBroadcastEnded(b.id);
      res.json({ ok: true });
    }),
  );

  r.get('/:id/status', validate({ params: idParam }), asyncHandler(async (req, res) => {
    const b = await load(req.params.id);
    res.json(media.statusFor(b.id));
  }));

  return r;
}

/**
 * Local HLS delivery (dev/demo only; production should set HLS_BASE_URL to a CDN). Every request must carry
 * a valid, unexpired signed prefix for that room, so the playlist is not world-readable.
 */
export function hlsStaticRoute({ media, config }) {
  const hls = media.providers.hls;
  const r = Router();
  if (!hls?.localServing) return r;
  r.use(
    '/:prefix/:room',
    (req, res, next) => {
      if (!/^zs-[0-9a-f]{24}$/.test(req.params.room) || !verifyHls(config.media.roomSalt, req.params.room, req.params.prefix)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid or expired media link' } });
      const origin = (req.get('origin') ?? '').replace(/\/$/, '');
      res.set({ 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'cross-origin' });
      if (origin && config.clientOrigins.includes(origin)) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      next();
    },
    (req, res, next) => express.static(path.join(hls.outputDir, req.params.room), { index: false, dotfiles: 'deny' })(req, res, next),
  );
  return r;
}
