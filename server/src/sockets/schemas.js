import { z } from 'zod';
import { LANGUAGE_CODES } from '@zerosignal/shared';
import { objectId } from '../middleware/validate.js';

const receiverKey = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'receiverId must be 1–40 letters, digits, _ or -');
const language = z.enum(LANGUAGE_CODES);
const location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();

export const metricsSchema = z.object({
  bandwidthKbps: z.number().min(0).max(10_000_000),
  latencyMs: z.number().min(0).max(120_000).optional(),
  packetLoss: z.number().min(0).max(100).optional(),
  jitterMs: z.number().min(0).max(120_000).optional(),
  stability: z.number().min(0).max(100).optional(),
  online: z.boolean().optional(),
});

export const joinSchema = z.object({
  broadcastId: objectId,
  receiverId: receiverKey,
  name: z.string().trim().min(1).max(60).optional(),
  language: language.optional(),
  location: location.optional(),
  /** Receivers may opt out of pre-emptive switching to demonstrate purely reactive behaviour. */
  autoPreempt: z.boolean().optional(),
});

export const opsJoinSchema = z.object({ broadcastId: objectId });

export const updateSchema = z.object({
  receiverId: receiverKey,
  language: language.optional(),
  location: location.nullable().optional(),
  autoPreempt: z.boolean().optional(),
});

export const networkSchema = z.object({
  receiverId: receiverKey,
  metrics: metricsSchema,
  /** false = measured on a real link (Live Mode); true = produced by the simulator. */
  simulated: z.boolean().default(true),
  /** Provenance of the reading: real WebRTC stats, an HTTP probe, or the simulator. Overrides `simulated` when present. */
  source: z.enum(['measured', 'probe', 'simulated']).optional(),
});

export const controlSchema = z.object({
  broadcastId: objectId,
  receiverId: receiverKey,
  command: z.object({
    preset: z.enum(['EXCELLENT', 'GOOD', 'MODERATE', 'POOR', 'CRITICAL', 'OFFLINE']).optional(),
    slider: z.number().min(0).max(100).optional(),
    scenario: z.enum(['degrading', 'chaos', 'stop']).optional(),
  }),
});

export const leaveSchema = z.object({ receiverId: receiverKey });

export const alertAckSchema = z.object({ receiverId: receiverKey, messageId: objectId });

export const alertResponseSchema = z.object({
  receiverId: receiverKey,
  messageId: objectId,
  status: z.enum(['SAFE', 'NEED_HELP']),
  location: location.optional(),
});
