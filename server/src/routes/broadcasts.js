import { Router } from 'express';
import { z } from 'zod';
import { Acknowledgment, AiUsage, Broadcast, DeliveryLog, EmergencyMessage, NetworkMetric, QualityEvent, ReceiverSession } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { idParam, validate } from '../middleware/validate.js';
import { computeAnalytics } from '../services/analytics.js';
import { asyncHandler, conflict, forbidden, notFound } from '../utils/errors.js';
import { sanitizeText } from '../utils/sanitize.js';

const zone = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), radiusKm: z.number().min(0.1).max(2000), label: z.string().trim().max(80).optional() });
const text = (max) => z.string().trim().max(max).transform((s) => sanitizeText(s, max));

const createBody = z.object({ title: text(140).pipe(z.string().min(3, 'Title must be at least 3 characters')), description: text(600).optional(), scenarioId: z.enum(['cyclone', 'flood', 'earthquake', 'tower']).optional(), zone: zone.optional() });
const patchBody = createBody.partial();

const view = (b) => ({ id: String(b._id), title: b.title, description: b.description, status: b.status, scenarioId: b.scenarioId ?? null, zone: b.zone?.lat != null ? b.zone : null, createdBy: b.createdBy ? String(b.createdBy) : null, startedAt: b.startedAt ?? null, endedAt: b.endedAt ?? null, peakReceivers: b.peakReceivers ?? 0, createdAt: b.createdAt });

export function broadcastRoutes({ realtime, media = null, audit = () => {} }) {
  const r = Router();
  r.use(authenticate);

  const load = async (id) => {
    const b = await Broadcast.findById(id);
    if (!b) throw notFound('Broadcast not found');
    return b;
  };
  /** Owners and admins may modify; other broadcasters may not. */
  const mustOwn = (req, b) => {
    if (req.user.role !== 'admin' && String(b.createdBy) !== req.user.id) throw forbidden('Only the broadcast owner or an admin can do that');
  };

  r.get(
    '/',
    validate({ query: z.object({ status: z.enum(['SCHEDULED', 'LIVE', 'ENDED']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) }),
    asyncHandler(async (req, res) => {
      const filter = req.query.status ? { status: req.query.status } : {};
      const rows = await Broadcast.find(filter).sort({ status: 1, startedAt: -1, createdAt: -1 }).limit(req.query.limit).lean();
      res.json({ broadcasts: rows.map(view) });
    }),
  );

  r.post(
    '/',
    requireRole('broadcaster', 'admin'),
    validate({ body: createBody }),
    asyncHandler(async (req, res) => {
      const b = await Broadcast.create({ ...req.body, createdBy: req.user.id, status: 'SCHEDULED' });
      audit('BROADCAST_CREATED', req, { targetId: String(b._id), meta: { title: b.title } });
      res.status(201).json({ broadcast: view(b) });
    }),
  );

  r.get(
    '/:id',
    validate({ params: idParam }),
    asyncHandler(async (req, res) => res.json({ broadcast: view(await load(req.params.id)) })),
  );

  r.patch(
    '/:id',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam, body: patchBody }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      mustOwn(req, b);
      Object.assign(b, req.body);
      await b.save();
      realtime.broadcastStatus(b, { transition: false }); // an edit is not a start/stop
      audit('BROADCAST_EDITED', req, { targetId: String(b._id), meta: { fields: Object.keys(req.body) } });
      res.json({ broadcast: view(b) });
    }),
  );

  r.delete(
    '/:id',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      mustOwn(req, b);
      if (b.status === 'LIVE') throw conflict('Stop the broadcast before deleting it');
      await Promise.all([
        EmergencyMessage.deleteMany({ broadcastId: b._id }), NetworkMetric.deleteMany({ broadcastId: b._id }), QualityEvent.deleteMany({ broadcastId: b._id }),
        ReceiverSession.deleteMany({ broadcastId: b._id }), DeliveryLog.deleteMany({ broadcastId: b._id }), Acknowledgment.deleteMany({ broadcastId: b._id }),
      ]);
      await b.deleteOne();
      audit('BROADCAST_DELETED', req, { targetId: String(b._id), meta: { title: b.title } });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/start',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      mustOwn(req, b);
      if (b.status === 'LIVE') throw conflict('Broadcast is already live');
      b.status = 'LIVE';
      b.startedAt = new Date();
      b.endedAt = undefined;
      await b.save();
      realtime.broadcastStatus(b);
      audit('BROADCAST_STARTED', req, { targetId: String(b._id) });
      res.json({ broadcast: view(b) });
    }),
  );

  r.post(
    '/:id/stop',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      mustOwn(req, b);
      if (b.status !== 'LIVE') throw conflict('Broadcast is not live');
      b.status = 'ENDED';
      b.endedAt = new Date();
      b.peakReceivers = Math.max(b.peakReceivers ?? 0, realtime.getReceivers(String(b._id)).length);
      await b.save();
      realtime.broadcastStatus(b);
      await media?.onBroadcastEnded?.(String(b._id)).catch(() => {});
      audit('BROADCAST_STOPPED', req, { targetId: String(b._id) });
      res.json({ broadcast: view(b) });
    }),
  );

  r.get(
    '/:id/receivers',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      await load(req.params.id);
      res.json({ receivers: realtime.getReceivers(req.params.id) });
    }),
  );

  /** Everything needed to replay a broadcast (spec §8.11). */
  r.get(
    '/:id/timeline',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      const q = { broadcastId: b._id };
      const [events, metrics, messages, acks, sessions] = await Promise.all([
        QualityEvent.find(q).sort({ at: 1 }).limit(2000).lean(),
        NetworkMetric.find(q).sort({ ts: 1 }).limit(6000).lean(),
        EmergencyMessage.find(q).sort({ sentAt: 1 }).select('-signed -original').lean(),
        Acknowledgment.find(q).sort({ at: 1 }).limit(1000).lean(),
        ReceiverSession.find(q).lean(),
      ]);
      res.json({ broadcast: view(b), events, metrics, messages, acks, sessions });
    }),
  );

  /** Exportable incident report (spec §8.16): analytics + timeline + delivery + AI usage in the window. */
  r.get(
    '/:id/report',
    requireRole('broadcaster', 'admin'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const b = await load(req.params.id);
      const q = { broadcastId: b._id };
      const from = b.startedAt ?? b.createdAt;
      const to = b.endedAt ?? new Date();
      const [messages, metrics, events, sessions, deliveries, acks, aiUsage] = await Promise.all([
        EmergencyMessage.find(q).sort({ sentAt: 1 }).select('-signed').lean(), NetworkMetric.find(q).sort({ ts: 1 }).limit(20000).lean(), QualityEvent.find(q).sort({ at: 1 }).lean(),
        ReceiverSession.find(q).lean(), DeliveryLog.find(q).lean(), Acknowledgment.find(q).lean(), AiUsage.find({ at: { $gte: from, $lte: to } }).lean(),
      ]);
      const analytics = computeAnalytics({ broadcasts: [b.toObject()], messages, metrics, events, sessions, deliveries, acks, aiUsage });
      res.json({
        generatedAt: new Date(), title: 'ZeroSignal incident report', broadcast: view(b), analytics,
        messages: messages.map((m) => ({ id: String(m._id), sentAt: m.sentAt, priority: m.priority, category: m.category, summary: m.summary, recommendedAction: m.recommendedAction, languages: Object.keys(m.translations ?? {}), aiSource: m.aiMeta?.source })),
        notes: ['Network conditions in ZeroSignal demos are SIMULATED unless a receiver reported Live Mode measurements.', 'Mesh relay and SMS fallback are SIMULATED channels.'],
      });
    }),
  );

  return r;
}
