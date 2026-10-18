import { Router } from 'express';
import { z } from 'zod';
import { CATEGORIES, LANGUAGE_CODES, PRIORITIES } from '@zerosignal/shared';
import { EmergencyMessage } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { idParam, objectId, validate } from '../middleware/validate.js';
import { createEmergencyMessage, translateExisting } from '../services/messages.js';
import { asyncHandler, badRequest, notFound } from '../utils/errors.js';
import { sanitizeText } from '../utils/sanitize.js';

const text = (min, max) => z.string().trim().min(min).max(max).transform((s) => sanitizeText(s, max)).pipe(z.string().min(min));

const analyzeBody = z.object({ text: text(10, 4000) });

const createBodySchema = z.object({
  broadcastId: objectId,
  original: text(10, 4000),
  priority: z.enum(PRIORITIES),
  category: z.enum(CATEGORIES),
  summary: text(3, 300),
  recommendedAction: text(3, 300),
  analysisId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  presetKey: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
  translateTo: z.array(z.enum(LANGUAGE_CODES)).max(4).optional(),
  expiresInMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  zone: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), radiusKm: z.number().min(0.1).max(2000), label: z.string().trim().max(80).optional() }).optional(),
});

const safe = (m) => ({
  id: String(m._id), broadcastId: String(m.broadcastId), priority: m.priority, category: m.category, summary: m.summary, recommendedAction: m.recommendedAction, confidence: m.confidence, original: m.original,
  translations: m.translations instanceof Map ? Object.fromEntries(m.translations) : m.translations, zone: m.zone?.lat != null ? m.zone : null, aiMeta: m.aiMeta, signed: m.signed instanceof Map ? Object.fromEntries(m.signed) : m.signed,
  sentAt: m.sentAt, expiresAt: m.expiresAt, supersededBy: m.supersededBy ? String(m.supersededBy) : null,
});

export function emergencyRoutes({ ai, signer, realtime, analysisCache, limiters, audit = () => {} }) {
  const r = Router();
  r.use(authenticate);

  // Step 1 of the broadcaster flow: raw announcement → AI (or fallback) analysis for human review.
  r.post(
    '/analyze',
    requireRole('broadcaster', 'admin'),
    limiters.ai,
    validate({ body: analyzeBody }),
    asyncHandler(async (req, res) => {
      const result = await ai.analyze(req.body.text, { userId: req.user.id });
      const analysisId = analysisCache.put(req.user.id, result);
      res.json({ analysisId, ...result });
    }),
  );

  // Step 2: the (possibly edited) message is signed, translated, persisted and delivered.
  r.post(
    '/',
    requireRole('broadcaster', 'admin'),
    limiters.ai,
    validate({ body: createBodySchema }),
    asyncHandler(async (req, res) => {
      const analysisRecord = req.body.analysisId ? analysisCache.get(req.body.analysisId, req.user.id) : null;
      if (req.body.analysisId && !analysisRecord) throw badRequest('That analysis has expired — analyse the message again');
      const out = await createEmergencyMessage({ input: req.body, user: req.user, ai, signer, realtime, analysisRecord });
      audit('ALERT_SENT', req, { targetId: String(out.message.id ?? out.message._id), meta: { broadcastId: String(out.message.broadcastId), priority: out.message.priority, category: out.message.category, supersedes: out.supersedes?.length ?? 0 } });
      res.status(201).json({ message: safe(out.message), dispatch: out.dispatch, translationStatus: out.translationStatus, supersedes: out.supersedes });
    }),
  );

  r.get(
    '/',
    validate({ query: z.object({ broadcastId: objectId.optional(), priority: z.enum(PRIORITIES).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) }),
    asyncHandler(async (req, res) => {
      const filter = {};
      if (req.query.broadcastId) filter.broadcastId = req.query.broadcastId;
      if (req.query.priority) filter.priority = req.query.priority;
      // Receivers only see delivered-style fields (no AI provenance or the raw original).
      const rows = await EmergencyMessage.find(filter).sort({ sentAt: -1 }).limit(req.query.limit).lean();
      const ops = req.user.role !== 'receiver';
      res.json({ messages: rows.map((m) => (ops ? safe(m) : { ...safe(m), original: undefined, aiMeta: undefined })) });
    }),
  );

  r.get(
    '/:id',
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const m = await EmergencyMessage.findById(req.params.id).lean();
      if (!m) throw notFound('Message not found');
      res.json({ message: req.user.role === 'receiver' ? { ...safe(m), original: undefined, aiMeta: undefined } : safe(m) });
    }),
  );

  r.post(
    '/:id/translate',
    requireRole('broadcaster', 'admin'),
    limiters.ai,
    validate({ params: idParam, body: z.object({ lang: z.enum(LANGUAGE_CODES.filter((l) => l !== 'en')) }) }),
    asyncHandler(async (req, res) => res.json(await translateExisting({ id: req.params.id, lang: req.body.lang, ai, signer, userId: req.user.id }))),
  );

  return r;
}
