import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AiUsage, Broadcast, EmergencyMessage, NetworkMetric, QualityEvent, ReceiverSession, User } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { objectId, validate } from '../middleware/validate.js';
import { aiStats } from '../services/analytics.js';
import { asyncHandler } from '../utils/errors.js';
import { sanitizeText } from '../utils/sanitize.js';

const DB_STATES = { 0: 'down', 1: 'up', 2: 'connecting', 3: 'disconnecting' };

/** Live status of every subsystem, for the System Health panel. */
export async function collectHealth({ config, ai, realtime, startedAt, media }) {
  const dbState = DB_STATES[mongoose.connection.readyState] ?? 'down';
  let dbLatencyMs = null;
  if (dbState === 'up') {
    const t = Date.now();
    try {
      await mongoose.connection.db.admin().ping();
      dbLatencyMs = Date.now() - t;
    } catch {
      return buildHealth('down');
    }
  }

  async function buildHealth(db) {
    const last = db === 'up' ? await AiUsage.findOne().sort({ at: -1 }).lean().catch(() => null) : null;
    const rt = realtime.stats();
    return {
      checkedAt: new Date(),
      api: { status: 'up', uptimeSec: Math.round((Date.now() - startedAt) / 1000), env: config.nodeEnv },
      mongodb: { status: db, latencyMs: dbLatencyMs },
      socketio: { status: 'up', ...rt },
      groq: { status: ai.enabled ? (last && !last.ok && last.source === 'fallback' ? 'degraded' : 'up') : 'fallback', configured: ai.enabled, model: config.groq.model, note: ai.enabled ? 'Groq configured; the rule-based fallback is always available.' : 'No GROQ_API_KEY — running in rule-based fallback mode.', lastCall: last ? { at: last.at, ok: last.ok, kind: last.kind } : null },
      streaming: media ? await media.healthAsync() : { status: 'up', provider: 'simulated', note: 'Simulated player only.' },
    };
  }
  return buildHealth(dbState);
}

export function adminRoutes({ config, ai, realtime, startedAt, limiters, accounts, repos, media }) {
  const r = Router();
  r.use(authenticate, requireRole('admin'));
  const ctxOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') ?? null });
  const ROLE = z.enum(['admin', 'broadcaster', 'receiver']);

  r.get('/health', asyncHandler(async (_req, res) => res.json(await collectHealth({ config, ai, realtime, startedAt, media }))));

  r.get(
    '/users',
    asyncHandler(async (_req, res) => {
      const users = await repos.users.list({ limit: 200 });
      res.json({ users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, invitePending: u.invitePending, twoFactorEnabled: Boolean(u.totp?.enabled), lastLoginAt: u.lastLoginAt ?? null, createdAt: u.createdAt })) });
    }),
  );

  // Staff and receiver accounts are created by an admin; the person sets their own password through an invite link.
  r.post(
    '/users',
    limiters.auth,
    validate({ body: z.object({ name: z.string().trim().min(2).max(80).transform((s) => sanitizeText(s, 80)), email: z.string().trim().toLowerCase().email().max(120), role: ROLE }) }),
    asyncHandler(async (req, res) => {
      const { user, inviteUrl } = await accounts.createAccount(req.user, req.body, ctxOf(req));
      res.status(201).json({ user, inviteUrl });
    }),
  );

  r.post(
    '/users/:id/invite',
    limiters.auth,
    validate({ params: z.object({ id: objectId }) }),
    asyncHandler(async (req, res) => res.json({ inviteUrl: await accounts.sendInvite(req.params.id, req.user, ctxOf(req)) })),
  );

  r.patch(
    '/users/:id/role',
    validate({ params: z.object({ id: objectId }), body: z.object({ role: ROLE }) }),
    asyncHandler(async (req, res) => res.json({ user: await accounts.setRole(req.user, req.params.id, req.body.role, ctxOf(req)) })),
  );

  r.patch(
    '/users/:id/active',
    validate({ params: z.object({ id: objectId }), body: z.object({ active: z.boolean() }) }),
    asyncHandler(async (req, res) => res.json({ user: await accounts.setActive(req.user, req.params.id, req.body.active, ctxOf(req)) })),
  );

  r.post(
    '/users/:id/logout',
    validate({ params: z.object({ id: objectId }) }),
    asyncHandler(async (req, res) => {
      await accounts.logoutEverywhere(req.params.id, { ...ctxOf(req), actorId: req.user.id });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/audit',
    validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), before: z.coerce.number().int().optional(), type: z.string().trim().max(40).optional() }) }),
    asyncHandler(async (req, res) => res.json({ events: await repos.audit.list(req.query) })),
  );

  r.get(
    '/overview',
    asyncHandler(async (_req, res) => {
      const [users, broadcasts, messages, aiUsage, avgNet, events] = await Promise.all([
        User.countDocuments(), Broadcast.find().sort({ createdAt: -1 }).limit(50).lean(), EmergencyMessage.countDocuments(), AiUsage.find().sort({ at: -1 }).limit(5000).lean(),
        NetworkMetric.aggregate([{ $group: { _id: null, bandwidthKbps: { $avg: '$bandwidthKbps' }, latencyMs: { $avg: '$latencyMs' }, packetLoss: { $avg: '$packetLoss' }, jitterMs: { $avg: '$jitterMs' }, samples: { $sum: 1 } } }]),
        QualityEvent.countDocuments(),
      ]);
      const live = realtime.getReceivers();
      res.json({
        counts: { users, broadcasts: broadcasts.length, liveBroadcasts: broadcasts.filter((b) => b.status === 'LIVE').length, messages, qualityEvents: events, activeReceivers: live.length },
        activeReceivers: live,
        ai: aiStats(aiUsage),
        network: avgNet[0] ? { bandwidthKbps: Math.round(avgNet[0].bandwidthKbps), latencyMs: Math.round(avgNet[0].latencyMs), packetLoss: Math.round(avgNet[0].packetLoss * 10) / 10, jitterMs: Math.round(avgNet[0].jitterMs), samples: avgNet[0].samples } : null,
        broadcasts: broadcasts.map((b) => ({ id: String(b._id), title: b.title, status: b.status, startedAt: b.startedAt ?? null })),
        sessions: await ReceiverSession.countDocuments(),
      });
    }),
  );

  return r;
}
