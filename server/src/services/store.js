/**
 * Persistence adapter for the real-time layer. The socket code talks to this narrow
 * interface instead of Mongoose directly, so it can be tested with a recording store and
 * so a database hiccup can never crash a live broadcast: every write is best-effort and
 * failures are logged, not thrown.
 */
import mongoose from 'mongoose';
import { Acknowledgment, Broadcast, DeliveryLog, NetworkMetric, QualityEvent, ReceiverSession } from '../models/index.js';
import { config } from '../config/env.js';

const log = (what, err) => {
  if (!config.isTest) console.error(`[store] ${what} failed:`, err?.message ?? err);
};

const attempt = async (what, fn, fallback = undefined) => {
  try {
    return await fn();
  } catch (err) {
    log(what, err);
    return fallback;
  }
};

const oid = (v) => (v && mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);

export function createMongoStore() {
  return {
    getBroadcast: (id) => attempt('getBroadcast', async () => (oid(id) ? Broadcast.findById(oid(id)).lean() : null), null),

    saveMetric: (m) => attempt('saveMetric', () => NetworkMetric.create({ ...m, broadcastId: oid(m.broadcastId) })),

    saveQualityEvent: (e) => attempt('saveQualityEvent', () => QualityEvent.create({ ...e, broadcastId: oid(e.broadcastId) })),

    startSession: (s) =>
      attempt('startSession', async () => {
        const doc = await ReceiverSession.create({ ...s, broadcastId: oid(s.broadcastId), userId: oid(s.userId) });
        return String(doc._id);
      }),

    updateSession: (id, patch) => attempt('updateSession', () => (oid(id) ? ReceiverSession.updateOne({ _id: oid(id) }, { $set: patch }) : null)),

    bumpReconnects: (id) => attempt('bumpReconnects', () => (oid(id) ? ReceiverSession.updateOne({ _id: oid(id) }, { $inc: { reconnects: 1 }, $unset: { leftAt: 1 } }) : null)),

    updateBroadcast: (id, patch) => attempt('updateBroadcast', () => Broadcast.updateOne({ _id: oid(id) }, { $set: patch })),

    saveAck: (a) =>
      attempt('saveAck', () =>
        Acknowledgment.updateOne(
          { messageId: oid(a.messageId), receiverId: a.receiverId, status: a.status },
          { $setOnInsert: { ...a, messageId: oid(a.messageId), broadcastId: oid(a.broadcastId), userId: oid(a.userId) } },
          { upsert: true },
        ),
      ),

    delivery: {
      upsert: (rec) =>
        attempt('delivery.upsert', () =>
          DeliveryLog.updateOne(
            { messageId: oid(rec.messageId), receiverId: rec.receiverId },
            { $setOnInsert: { ...rec, messageId: oid(rec.messageId) } },
            { upsert: true },
          ),
        ),
      update: (messageId, receiverId, patch) =>
        attempt('delivery.update', () => DeliveryLog.updateOne({ messageId: oid(messageId), receiverId }, { $set: patch })),
    },
  };
}
