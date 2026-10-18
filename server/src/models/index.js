/**
 * Mongoose models — one file (spec §5 collections plus auth: refreshTokens, authTokens, auditLogs):
 * users, broadcasts, emergencyMessages, networkMetrics, qualityEvents,
 * receiverSessions, deliveryLogs, aiUsage, acknowledgments.
 *
 * Seed provenance is tracked INTERNALLY by `seedBatchId` (select:false, so it is never returned by
 * queries, `.lean()`, JSON or exports). `npm run seed:clean` removes exactly the documents carrying it.
 * Nothing in the API or UI can reveal or depend on it.
 */
import mongoose from 'mongoose';
import { CATEGORIES, PRIORITIES, TIERS, MODES } from '@zerosignal/shared';

const { Schema, model, models } = mongoose;

const opts = { timestamps: true, versionKey: false };
/** Internal seed marker. select:false keeps it out of every read unless explicitly requested. */
const seedField = () => ({ type: String, select: false, index: true });
const ref = (name) => ({ type: Schema.Types.ObjectId, ref: name });

const metricsShape = {
  bandwidthKbps: Number,
  latencyMs: Number,
  packetLoss: Number,
  jitterMs: Number,
  stability: Number,
  online: { type: Boolean, default: true },
};

const zoneShape = { lat: Number, lng: Number, radiusKm: Number, label: String };

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'broadcaster', 'receiver'], required: true, index: true },
    active: { type: Boolean, default: true },
    invitePending: { type: Boolean, default: false },
    preferredLanguage: { type: String, enum: ['en', 'ta', 'hi', 'te'], default: 'en' },
    theme: { type: String, enum: ['light', 'dark', 'system'] },
    phone: { type: String, maxlength: 20 },
    /** Only stored when the receiver chooses to share it at sign-up. */
    location: { lat: Number, lng: Number },
    failedLogins: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    tokenVersion: { type: Number, default: 0, select: false },
    totp: {
      type: new Schema({ enabled: Boolean, secretSealed: String, pendingSealed: String, lastStep: Number, backupHashes: [String] }, { _id: false }),
      select: false,
    },
    lastLoginAt: Date,
    seedBatchId: seedField(),
  },
  opts,
);

const broadcastSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, default: '', maxlength: 600 },
    status: { type: String, enum: ['SCHEDULED', 'LIVE', 'ENDED'], default: 'SCHEDULED', index: true },
    scenarioId: { type: String, default: null },
    createdBy: ref('User'),
    startedAt: Date,
    endedAt: Date,
    zone: zoneShape,
    peakReceivers: { type: Number, default: 0 },
    seedBatchId: seedField(),
  },
  opts,
);

const translationShape = new Schema(
  {
    text: String,
    summary: String,
    action: String,
    source: { type: String, enum: ['groq', 'preset', 'original'], default: 'groq' },
  },
  { _id: false },
);

const emergencyMessageSchema = new Schema(
  {
    broadcastId: { ...ref('Broadcast'), index: true },
    createdBy: ref('User'),
    original: { type: String, required: true, maxlength: 4000 },
    summary: { type: String, required: true, maxlength: 300 },
    category: { type: String, enum: CATEGORIES, default: 'OTHER' },
    priority: { type: String, enum: PRIORITIES, required: true, index: true },
    recommendedAction: { type: String, default: '', maxlength: 300 },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    translations: { type: Map, of: translationShape, default: {} },
    zone: zoneShape,
    aiMeta: {
      source: { type: String, enum: ['groq', 'fallback', 'manual', 'preset'], default: 'manual' },
      model: String,
      latencyMs: Number,
      fallback: { type: Boolean, default: false },
      reason: String,
      editedByHuman: { type: Boolean, default: false },
    },
    /** Compact alert payloads per language + Ed25519 signature over canonical JSON. */
    signed: {
      type: Map,
      of: new Schema({ payload: Schema.Types.Mixed, signature: String, bytes: Number }, { _id: false }),
      default: {},
    },
    sentAt: { type: Date, index: true },
    expiresAt: Date,
    supersededBy: ref('EmergencyMessage'),
    seedBatchId: seedField(),
  },
  opts,
);

const networkMetricSchema = new Schema(
  {
    broadcastId: { ...ref('Broadcast'), index: true },
    receiverId: { type: String, required: true },
    ts: { type: Date, required: true },
    ...metricsShape,
    tier: { type: String, enum: TIERS },
    healthScore: Number,
    simulated: { type: Boolean, default: true },
    /** measured = real WebRTC stats · probe = HTTP probe estimate · simulated */
    source: { type: String, enum: ['measured', 'probe', 'simulated'], default: undefined },
    seedBatchId: seedField(),
  },
  { versionKey: false },
);
networkMetricSchema.index({ broadcastId: 1, receiverId: 1, ts: 1 });

const qualityEventSchema = new Schema(
  {
    broadcastId: { ...ref('Broadcast'), index: true },
    receiverId: { type: String, required: true },
    from: { type: String, enum: TIERS },
    to: { type: String, enum: TIERS, required: true },
    fromMode: { type: String, enum: Object.values(MODES) },
    toMode: { type: String, enum: Object.values(MODES) },
    direction: { type: String, enum: ['UP', 'DOWN'] },
    trigger: { type: String, enum: ['REACTIVE', 'PREDICTIVE'], default: 'REACTIVE' },
    reason: { type: String, required: true, maxlength: 500 },
    priority: { type: String, enum: PRIORITIES, default: 'NORMAL' },
    metrics: metricsShape,
    factors: Schema.Types.Mixed,
    at: { type: Date, required: true, index: true },
    seedBatchId: seedField(),
  },
  { versionKey: false },
);
qualityEventSchema.index({ broadcastId: 1, at: 1 });

const receiverSessionSchema = new Schema(
  {
    broadcastId: { ...ref('Broadcast'), index: true },
    receiverId: { type: String, required: true },
    userId: ref('User'),
    name: { type: String, maxlength: 80 },
    language: { type: String, enum: ['en', 'ta', 'hi', 'te'], default: 'en' },
    location: { lat: Number, lng: Number },
    joinedAt: { type: Date, required: true },
    leftAt: Date,
    lastTier: { type: String, enum: TIERS },
    reconnects: { type: Number, default: 0 },
    seedBatchId: seedField(),
  },
  { versionKey: false },
);
receiverSessionSchema.index({ broadcastId: 1, receiverId: 1 });

const deliveryLogSchema = new Schema(
  {
    messageId: { ...ref('EmergencyMessage'), index: true },
    broadcastId: { ...ref('Broadcast'), index: true },
    receiverId: { type: String, required: true },
    priority: { type: String, enum: PRIORITIES },
    channel: { type: String, enum: ['TEXT', 'AUDIO', 'VIDEO', 'CACHE', 'SMS_SIMULATED', 'MESH_SIMULATED'], default: 'TEXT' },
    status: { type: String, enum: ['PENDING', 'DELIVERED', 'ACKED', 'EXPIRED', 'DEFERRED'], default: 'PENDING', index: true },
    attempts: { type: Number, default: 0 },
    nextRetryAt: Date,
    deliveredAt: Date,
    ackedAt: Date,
    seedBatchId: seedField(),
  },
  opts,
);
deliveryLogSchema.index({ messageId: 1, receiverId: 1 }, { unique: true });

const aiUsageSchema = new Schema(
  {
    kind: { type: String, enum: ['analyze', 'translate', 'summarize'], required: true },
    ok: { type: Boolean, required: true },
    source: { type: String, enum: ['groq', 'fallback'], required: true },
    latencyMs: Number,
    error: { type: String, maxlength: 200 },
    userId: ref('User'),
    at: { type: Date, required: true, index: true },
    seedBatchId: seedField(),
  },
  { versionKey: false },
);

const acknowledgmentSchema = new Schema(
  {
    messageId: { ...ref('EmergencyMessage'), index: true },
    broadcastId: { ...ref('Broadcast'), index: true },
    receiverId: { type: String, required: true },
    userId: ref('User'),
    status: { type: String, enum: ['RECEIVED', 'SAFE', 'NEED_HELP'], required: true },
    location: { lat: Number, lng: Number },
    at: { type: Date, required: true },
    seedBatchId: seedField(),
  },
  { versionKey: false },
);
acknowledgmentSchema.index({ messageId: 1, receiverId: 1, status: 1 }, { unique: true });


/** Rotating refresh tokens. Only the sha256 of the token is stored. Documents expire on their own. */
const refreshTokenSchema = new Schema(
  {
    familyId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    rotatedAt: Date,
    revokedAt: Date,
    userAgent: String,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** One-time password-reset and invite tokens (hashed). */
const authTokenSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    purpose: { type: String, enum: ['reset', 'invite'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

/** Append-only audit trail (auth events and operator actions). TTL-pruned per AUDIT_RETENTION_DAYS. */
const auditLogSchema = new Schema(
  {
    type: { type: String, required: true, index: true },
    at: { type: Date, required: true },
    actorId: { type: String, index: true },
    targetId: { type: String, index: true },
    ip: String,
    userAgent: String,
    meta: Schema.Types.Mixed,
  },
  { versionKey: false },
);
auditLogSchema.index({ at: -1 });
auditLogSchema.index({ at: 1 }, { expireAfterSeconds: Math.max(1, Number.parseInt(process.env.AUDIT_RETENTION_DAYS ?? '365', 10) || 365) * 86_400 });

const get = (name, schema, collection) => models[name] || model(name, schema, collection);

export const User = get('User', userSchema, 'users');
export const Broadcast = get('Broadcast', broadcastSchema, 'broadcasts');
export const EmergencyMessage = get('EmergencyMessage', emergencyMessageSchema, 'emergencyMessages');
export const NetworkMetric = get('NetworkMetric', networkMetricSchema, 'networkMetrics');
export const QualityEvent = get('QualityEvent', qualityEventSchema, 'qualityEvents');
export const ReceiverSession = get('ReceiverSession', receiverSessionSchema, 'receiverSessions');
export const DeliveryLog = get('DeliveryLog', deliveryLogSchema, 'deliveryLogs');
export const AiUsage = get('AiUsage', aiUsageSchema, 'aiUsage');
export const Acknowledgment = get('Acknowledgment', acknowledgmentSchema, 'acknowledgments');
export const RefreshToken = get('RefreshToken', refreshTokenSchema, 'refreshTokens');
export const AuthToken = get('AuthToken', authTokenSchema, 'authTokens');
export const AuditLog = get('AuditLog', auditLogSchema, 'auditLogs');

/** Collections that can carry seeded documents (see seed/index.js). */
export const ALL_MODELS = { User, Broadcast, EmergencyMessage, NetworkMetric, QualityEvent, ReceiverSession, DeliveryLog, AiUsage, Acknowledgment };
