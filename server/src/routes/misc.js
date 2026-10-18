/** Smaller route groups: AI, alerts (signature), network metrics, analytics. */
import { Router } from 'express';
import { z } from 'zod';
import { LANGUAGE_CODES, buildQualityEvent, createEngineState, decide, signalHealthScore } from '@zerosignal/shared';
import { Acknowledgment, AiUsage, Broadcast, DeliveryLog, EmergencyMessage, NetworkMetric, QualityEvent, ReceiverSession } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { objectId, validate } from '../middleware/validate.js';
import { computeAnalytics } from '../services/analytics.js';
import { asyncHandler, notFound } from '../utils/errors.js';
import { sanitizeText } from '../utils/sanitize.js';

const text = (min, max) => z.string().trim().min(min).max(max).transform((s) => sanitizeText(s, max)).pipe(z.string().min(min));

// ───────────────────────── AI ─────────────────────────
export function aiRoutes({ ai, limiters }) {
  const r = Router();
  r.use(authenticate);

  r.get('/status', requireRole('broadcaster', 'admin'), (_req, res) => res.json({ enabled: ai.enabled, fallbackAvailable: true }));

  r.post(
    '/summarize',
    requireRole('broadcaster', 'admin'),
    limiters.ai,
    validate({ body: z.object({ text: text(10, 4000) }) }),
    asyncHandler(async (req, res) => res.json(await ai.summarize(req.body.text, { userId: req.user.id }))),
  );

  r.post(
    '/translate',
    requireRole('broadcaster', 'admin'),
    limiters.ai,
    validate({ body: z.object({ text: text(3, 4000), summary: text(3, 300).optional(), action: text(3, 300).optional(), lang: z.enum(LANGUAGE_CODES.filter((l) => l !== 'en')) }) }),
    asyncHandler(async (req, res) => res.json(await ai.translate({ text: req.body.text, summary: req.body.summary, action: req.body.action }, req.body.lang, { userId: req.user.id }))),
  );
  return r;
}

// ───────────────────────── Alert integrity ─────────────────────────
export function alertRoutes({ signer }) {
  const r = Router();

  r.get('/public-key', (_req, res) => res.json({ algorithm: signer.algorithm, publicKey: signer.publicKeyB64, encoding: 'base64 (raw 32-byte Ed25519 public key)', signs: 'canonical JSON (sorted keys) of the compact alert payload' }));

  // Fallback for browsers without WebCrypto Ed25519. Public on purpose: it only reveals validity.
  r.post(
    '/verify',
    validate({ body: z.object({ payload: z.record(z.any()), signature: z.string().max(200) }) }),
    (req, res) => res.json({ valid: signer.verify(req.body.payload, req.body.signature) }),
  );

  r.get(
    '/latest',
    authenticate,
    validate({ query: z.object({ broadcastId: objectId }) }),
    asyncHandler(async (req, res) => {
      const m = await EmergencyMessage.findOne({ broadcastId: req.query.broadcastId, priority: 'CRITICAL', supersededBy: { $exists: false }, expiresAt: { $gt: new Date() } }).sort({ sentAt: -1 }).lean();
      if (!m) throw notFound('No active critical alert');
      res.json({ id: String(m._id), sentAt: m.sentAt, expiresAt: m.expiresAt, priority: m.priority, category: m.category, translations: m.translations, signed: m.signed });
    }),
  );
  return r;
}

// ───────────────────────── Network metrics ─────────────────────────
const sample = z.object({
  receiverId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  ts: z.coerce.date().optional(),
  bandwidthKbps: z.number().min(0).max(10_000_000),
  latencyMs: z.number().min(0).max(120_000).optional(),
  packetLoss: z.number().min(0).max(100).optional(),
  jitterMs: z.number().min(0).max(120_000).optional(),
  stability: z.number().min(0).max(100).optional(),
  online: z.boolean().optional(),
  simulated: z.boolean().default(true),
});

export function networkRoutes() {
  const r = Router();

  // RTT / throughput probes for Live Mode. Unauthenticated, tiny, capped, covered by the general limiter.
  r.get('/probe', (_req, res) => res.set('Cache-Control', 'no-store').json({ t: Date.now() }));
  r.get(
    '/payload',
    validate({ query: z.object({ kb: z.coerce.number().int().min(1).max(256).default(64) }) }),
    (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream' }).send(Buffer.alloc(req.query.kb * 1024, 0x5a));
    },
  );

  // Metrics hold every receiver's link data and write straight to the database: staff only.
  r.use(authenticate, requireRole('broadcaster', 'admin'));

  // Batch ingest (e.g. buffered Live Mode samples). Runs the SAME engine, statelessly per receiver.
  r.post(
    '/metrics',
    validate({ body: z.object({ broadcastId: objectId, samples: z.array(sample).min(1).max(200) }) }),
    asyncHandler(async (req, res) => {
      const b = await Broadcast.findById(req.body.broadcastId).lean();
      if (!b) throw notFound('Broadcast not found');
      const states = new Map();
      const docs = [];
      const events = [];
      for (const s of [...req.body.samples].sort((a, c) => (a.ts?.getTime() ?? 0) - (c.ts?.getTime() ?? 0))) {
        const ts = s.ts ?? new Date();
        const { decision, state } = decide(s, 'NORMAL', states.get(s.receiverId) ?? createEngineState());
        states.set(s.receiverId, state);
        docs.push({ broadcastId: b._id, receiverId: s.receiverId, ts, bandwidthKbps: s.bandwidthKbps, latencyMs: s.latencyMs, packetLoss: s.packetLoss, jitterMs: s.jitterMs, stability: s.stability, online: s.online ?? true, tier: decision.tier, healthScore: signalHealthScore(s).score, simulated: s.simulated });
        const e = buildQualityEvent(decision, { at: ts, receiverId: s.receiverId, broadcastId: b._id });
        if (e) events.push(e);
      }
      await NetworkMetric.insertMany(docs);
      if (events.length) await QualityEvent.insertMany(events);
      res.status(201).json({ stored: docs.length, transitions: events.length });
    }),
  );

  r.get(
    '/metrics',
    validate({ query: z.object({ broadcastId: objectId, receiverId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(), since: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(5000).default(500) }) }),
    asyncHandler(async (req, res) => {
      const q = { broadcastId: req.query.broadcastId };
      if (req.query.receiverId) q.receiverId = req.query.receiverId;
      if (req.query.since) q.ts = { $gte: req.query.since };
      const rows = await NetworkMetric.find(q).sort({ ts: -1 }).limit(req.query.limit).lean();
      res.json({ metrics: rows.reverse() });
    }),
  );
  return r;
}

// ───────────────────────── Analytics ─────────────────────────
export function analyticsRoutes() {
  const r = Router();
  r.use(authenticate, requireRole('broadcaster', 'admin'));

  const buckets = z.object({ buckets: z.coerce.number().int().min(4).max(60).default(24) });

  r.get(
    '/global',
    validate({ query: buckets }),
    asyncHandler(async (req, res) => {
      const [broadcasts, messages, metrics, events, sessions, deliveries, acks, aiUsage] = await Promise.all([
        Broadcast.find().lean(), EmergencyMessage.find().select('priority category').lean(), NetworkMetric.find().sort({ ts: -1 }).limit(20000).lean(), QualityEvent.find().sort({ at: -1 }).limit(5000).lean(),
        ReceiverSession.find().lean(), DeliveryLog.find().lean(), Acknowledgment.find().lean(), AiUsage.find().sort({ at: -1 }).limit(5000).lean(),
      ]);
      res.json(computeAnalytics({ broadcasts, messages, metrics, events, sessions, deliveries, acks, aiUsage }, { buckets: req.query.buckets }));
    }),
  );

  r.get(
    '/broadcasts/:id',
    validate({ params: z.object({ id: objectId }), query: buckets }),
    asyncHandler(async (req, res) => {
      const b = await Broadcast.findById(req.params.id).lean();
      if (!b) throw notFound('Broadcast not found');
      const q = { broadcastId: b._id };
      const [messages, metrics, events, sessions, deliveries, acks] = await Promise.all([
        EmergencyMessage.find(q).select('priority category').lean(), NetworkMetric.find(q).sort({ ts: 1 }).limit(20000).lean(), QualityEvent.find(q).sort({ at: 1 }).lean(),
        ReceiverSession.find(q).lean(), DeliveryLog.find(q).lean(), Acknowledgment.find(q).lean(),
      ]);
      res.json(computeAnalytics({ broadcasts: [b], messages, metrics, events, sessions, deliveries, acks }, { buckets: req.query.buckets }));
    }),
  );
  return r;
}
