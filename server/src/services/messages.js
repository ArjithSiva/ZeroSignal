/**
 * Emergency-message pipeline: assemble translations, sign, supersede older alerts, persist,
 * and hand to the real-time layer for per-receiver delivery.
 */
import mongoose from 'mongoose';
import { LANGUAGE_CODES, SCENARIOS } from '@zerosignal/shared';
import { Broadcast, EmergencyMessage } from '../models/index.js';
import { notFound, badRequest } from '../utils/errors.js';

export const EXPIRY_MIN = { CRITICAL: 360, HIGH: 720, NORMAL: 1440, LOW: 2880 };

const plain = (v) => (v instanceof Map ? Object.fromEntries(v) : (v ?? {}));

/** DB document (lean or hydrated) → the shape the real-time layer and clients use. */
export function toWire(doc, supersedes = []) {
  const d = typeof doc.toObject === 'function' ? doc.toObject({ flattenMaps: true }) : doc;
  return {
    id: String(d._id),
    broadcastId: String(d.broadcastId),
    priority: d.priority,
    category: d.category,
    confidence: d.confidence,
    sentAt: new Date(d.sentAt).getTime(),
    expiresAt: d.expiresAt ? new Date(d.expiresAt).getTime() : null,
    zone: d.zone?.lat != null ? { lat: d.zone.lat, lng: d.zone.lng, radiusKm: d.zone.radiusKm, label: d.zone.label } : null,
    supersedes,
    translations: plain(d.translations),
    signed: plain(d.signed),
  };
}

/** Look up a scenario preset message by its key. */
export function findPreset(key) {
  for (const s of Object.values(SCENARIOS)) {
    const m = s.messages.find((x) => x.key === key);
    if (m) return m;
  }
  return null;
}

/**
 * Resolve translations: preset translations (labelled 'preset') or server-side Groq calls
 * (labelled 'groq'). Languages that cannot be translated trustworthily are simply absent and
 * reported in `translationStatus` — we never invent a translation.
 */
async function buildTranslations({ original, summary, action, presetKey, translateTo, ai, userId }) {
  const translations = { en: { text: original, summary, action, source: 'original' } };
  const status = {};
  if (presetKey) {
    const preset = findPreset(presetKey);
    if (!preset) throw badRequest('Unknown preset');
    for (const lang of LANGUAGE_CODES) {
      if (lang === 'en') continue;
      translations[lang] = { ...preset.i18n[lang], source: 'preset' };
      status[lang] = 'preset';
    }
    return { translations, status };
  }
  const wanted = [...new Set(translateTo ?? [])].filter((l) => l !== 'en' && LANGUAGE_CODES.includes(l));
  const results = await Promise.all(wanted.map((lang) => ai.translate({ text: original, summary, action }, lang, { userId })));
  wanted.forEach((lang, i) => {
    const r = results[i];
    if (r.available) {
      translations[lang] = { text: r.text, summary: r.summary, action: r.action, source: 'groq' };
      status[lang] = 'groq';
    } else {
      status[lang] = `unavailable: ${r.reason}`;
    }
  });
  return { translations, status };
}

/**
 * @param {object} p
 * @param {object} p.input validated request body
 * @param {{ id: string }} p.user
 * @param {object} p.ai AI service
 * @param {{ signMessage: Function }} p.signer
 * @param {{ dispatchMessage: Function }} p.realtime
 * @param {{ analysis?: object, meta?: object }|null} [p.analysisRecord] server-side record from /analyze
 */
export async function createEmergencyMessage({ input, user, ai, signer, realtime, analysisRecord = null, nowMs = Date.now() }) {
  const broadcast = await Broadcast.findById(input.broadcastId).lean();
  if (!broadcast) throw notFound('Broadcast not found');
  if (broadcast.status === 'ENDED') throw badRequest('That broadcast has ended');

  const { translations, status } = await buildTranslations({
    original: input.original, summary: input.summary, action: input.recommendedAction, presetKey: input.presetKey, translateTo: input.translateTo, ai, userId: user.id,
  });

  const _id = new mongoose.Types.ObjectId();
  const sentAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + (input.expiresInMinutes ?? EXPIRY_MIN[input.priority]) * 60_000);
  const zone = input.zone ?? broadcast.zone ?? undefined;
  const signed = signer.signMessage({
    id: String(_id), priority: input.priority, category: input.category, issuedAtSec: Math.floor(nowMs / 1000), expiresAtSec: Math.floor(expiresAt.getTime() / 1000), zone, i18n: translations,
  });

  // Provenance is recorded from the SERVER's own analysis record, never trusted from the client.
  let aiMeta = { source: 'manual', fallback: false, editedByHuman: false };
  if (input.presetKey) aiMeta = { source: 'preset', model: 'authored-preset', fallback: false, editedByHuman: false };
  else if (analysisRecord) {
    const a = analysisRecord.analysis;
    const edited = a.priority !== input.priority || a.category !== input.category || a.summary !== input.summary || a.recommendedAction !== input.recommendedAction;
    aiMeta = { source: analysisRecord.meta.source, model: analysisRecord.meta.model, latencyMs: analysisRecord.meta.latencyMs, fallback: analysisRecord.meta.fallback, reason: analysisRecord.meta.reason ?? undefined, editedByHuman: edited };
  }

  // New alerts supersede still-live older alerts of the same category in this broadcast.
  const older = await EmergencyMessage.find({ broadcastId: broadcast._id, category: input.category, supersededBy: { $exists: false }, expiresAt: { $gt: sentAt } }, { _id: 1 }).lean();
  const supersedes = older.map((o) => String(o._id));

  const doc = await EmergencyMessage.create({
    _id, broadcastId: broadcast._id, createdBy: user.id, original: input.original, summary: input.summary, category: input.category, priority: input.priority,
    recommendedAction: input.recommendedAction, confidence: analysisRecord?.analysis.confidence ?? (input.presetKey ? findPreset(input.presetKey).confidence : 1), translations, zone, aiMeta, signed, sentAt, expiresAt,
  });
  if (supersedes.length) await EmergencyMessage.updateMany({ _id: { $in: supersedes } }, { $set: { supersededBy: _id } });

  const dispatch = await realtime.dispatchMessage(toWire(doc, supersedes));
  return { message: doc.toObject({ flattenMaps: true }), dispatch, translationStatus: status, supersedes };
}

/** Add one language to an existing message (translated by Groq) and re-sign that language. */
export async function translateExisting({ id, lang, ai, signer, userId }) {
  const doc = await EmergencyMessage.findById(id);
  if (!doc) throw notFound('Message not found');
  const en = plain(doc.translations).en ?? { text: doc.original, summary: doc.summary, action: doc.recommendedAction };
  const r = await ai.translate({ text: en.text, summary: en.summary, action: en.action }, lang, { userId });
  if (!r.available) return { available: false, reason: r.reason };
  const translations = { ...plain(doc.translations), [lang]: { text: r.text, summary: r.summary, action: r.action, source: 'groq' } };
  const signed = signer.signMessage({ id: String(doc._id), priority: doc.priority, category: doc.category, issuedAtSec: Math.floor(doc.sentAt.getTime() / 1000), expiresAtSec: doc.expiresAt ? Math.floor(doc.expiresAt.getTime() / 1000) : undefined, zone: doc.zone?.lat != null ? doc.zone : undefined, i18n: translations });
  doc.translations = translations;
  doc.signed = signed;
  await doc.save();
  return { available: true, translation: translations[lang], signed: signed[lang] };
}
