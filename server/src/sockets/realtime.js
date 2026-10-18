/**
 * Real-time layer (Socket.IO).
 *
 * Rooms
 *   lobby            every authenticated socket; light broadcast:status only
 *   b:<broadcastId>  receivers of that broadcast (broadcast:start/stop/status, sync)
 *   ops:<broadcastId> broadcasters/admins watching it (receiver grid, quality events, deliveries)
 *   r:<receiverId>   one receiver's private channel (its own alerts, quality changes, controls)
 *
 * Every receiver has its OWN engine state, sample history and prediction. Receivers never see
 * each other's metrics: receiver:state / quality:changed go to ops + the receiver's own room only.
 *
 * Mesh relay and SMS fallback are SIMULATED; every event for them carries `simulated: true`.
 */
import {
  DEFAULT_CONFIG,
  MESH_RANGE_KM,
  TIER_RANK,
  applyPreemptive,
  broadcastQualityScore,
  buildQualityEvent,
  createEngineState,
  decide,
  haversineKm,
  inZone,
  planDelivery,
  predictDegradation,
  signalHealthScore,
  layerForTier,
} from '@zerosignal/shared';
import { verifyToken } from '../middleware/auth.js';
import { createDeliveryTracker } from '../services/delivery.js';
import { alertAckSchema, alertResponseSchema, controlSchema, joinSchema, leaveSchema, networkSchema, opsJoinSchema, updateSchema } from './schemas.js';

export const GRACE_MS = 60_000;
const PERSIST_METRIC_EVERY_MS = 2000;
const MIN_UPDATE_INTERVAL_MS = 40;
const MAX_SAMPLES = 30;
const PRIORITY_ORDER = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

const rooms = {
  lobby: 'lobby',
  b: (id) => `b:${id}`,
  ops: (id) => `ops:${id}`,
  r: (rid) => `r:${rid}`,
};

/**
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io
 * @param {object} deps.store persistence adapter (see services/store.js)
 * @param {() => number} [deps.now]
 * @param {typeof DEFAULT_CONFIG} [deps.engineConfig]
 * @param {number} [deps.graceMs]
 * @param {number[]} [deps.backoffMs]
 */
export function createRealtime({ io, store, now = () => Date.now(), engineConfig = DEFAULT_CONFIG, graceMs = GRACE_MS, backoffMs }) {
  /** receiverId → receiver record */
  const receivers = new Map();
  /** broadcastId → Map(messageId → message) of live (unexpired, unsuperseded) alerts */
  const activeAlerts = new Map();
  /** `${messageId}::${receiverId}` already delivered in this process (resync de-duplication) */
  const deliveredKeys = new Set();
  const counters = { updates: 0, dropped: 0 };

  // ───────────────────────── helpers ─────────────────────────
  const emitOps = (broadcastId, event, payload) => io.to(rooms.ops(broadcastId)).emit(event, payload);
  const emitReceiver = (rid, event, payload) => io.to(rooms.r(rid)).emit(event, payload);

  const publicReceiver = (r) => ({
    id: r.id,
    name: r.name,
    broadcastId: r.broadcastId,
    language: r.language,
    location: r.location ?? null,
    connection: r.status,
    tier: r.engine.tier,
    /** Which media layer the receiver should be on. The server decides; the player only follows. null = text-only. */
    layer: layerForTier(r.engine.tier),
    mode: r.lastDecision?.mode ?? null,
    reason: r.lastDecision?.reason ?? null,
    metrics: r.lastMetrics ?? null,
    simulated: r.simulated,
    metricSource: r.metricSource ?? (r.simulated ? 'simulated' : 'probe'),
    health: r.health ?? null,
    quality: r.quality ?? null,
    prediction: r.prediction ? { predicted: r.prediction.predicted, message: r.prediction.message, detail: r.prediction.detail, confidence: r.prediction.confidence, predictedTier: r.prediction.predictedTier, horizonSec: r.prediction.horizonSec } : null,
    autoPreempt: r.autoPreempt,
    reconnects: r.reconnects,
    joinedAt: r.joinedAt,
    updatedAt: r.updatedAt,
  });

  const livePriority = (broadcastId) => {
    let best = 'NORMAL';
    for (const m of activeAlerts.get(broadcastId)?.values() ?? []) {
      if (PRIORITY_ORDER.indexOf(m.priority) > PRIORITY_ORDER.indexOf(best)) best = m.priority;
    }
    return best;
  };

  const pruneExpired = (broadcastId) => {
    const map = activeAlerts.get(broadcastId);
    if (!map) return;
    for (const [id, m] of map) if (m.expiresAt != null && now() >= m.expiresAt) map.delete(id);
  };

  /** Neighbour with a healthy link within simulated mesh range, or null. */
  const meshNeighbour = (r) => {
    if (!r.location) return null;
    let best = null;
    for (const o of receivers.values()) {
      if (o.id === r.id || o.broadcastId !== r.broadcastId || o.status !== 'CONNECTED' || !o.location) continue;
      if (!(TIER_RANK[o.engine.tier] >= TIER_RANK['240p'])) continue;
      const d = haversineKm(r.location, o.location);
      if (d <= MESH_RANGE_KM && (!best || d < best.d)) best = { o, d };
    }
    return best?.o ?? null;
  };

  /** How can this receiver be reached RIGHT NOW? (see delivery.js for the semantics) */
  const route = (rid, message) => {
    const r = receivers.get(rid);
    if (!r) return { kind: 'HOLD' };
    if (r.status === 'DISCONNECTED') return { kind: 'HOLD' };
    const tier = r.engine.tier;
    if (tier == null) return { kind: 'DIRECT' };
    if (tier === 'CACHED') {
      const via = meshNeighbour(r);
      if (via && (message.priority === 'CRITICAL' || message.priority === 'HIGH')) return { kind: 'MESH', via: via.id };
      return message.priority === 'CRITICAL' || message.priority === 'HIGH' ? { kind: 'SMS' } : { kind: 'HOLD' };
    }
    return planDelivery(tier, message.priority, engineConfig).deferred ? { kind: 'HOLD' } : { kind: 'DIRECT' };
  };

  /** What goes over the wire: a <1 KB signed compact alert on TEXT/SMS/MESH, the full message otherwise. */
  const wireFor = (m, r, kind) => {
    const compact = kind !== 'DIRECT' || r.engine.tier === 'TEXT';
    const base = { id: m.id, broadcastId: m.broadcastId, priority: m.priority, category: m.category, sentAt: m.sentAt, expiresAt: m.expiresAt, zone: m.zone ?? null, supersedes: m.supersedes ?? [] };
    if (compact) {
      const langs = [...new Set([r.language, 'en'])].filter((l) => m.signed[l]);
      return { ...base, compact: true, signed: Object.fromEntries(langs.map((l) => [l, m.signed[l]])) };
    }
    return { ...base, compact: false, confidence: m.confidence, translations: m.translations, signed: m.signed };
  };

  const send = (rid, routeInfo, message) => {
    const r = receivers.get(rid);
    if (!r) return;
    const m = message.wire;
    const wire = wireFor(m, r, routeInfo.kind);
    const bytes = Buffer.byteLength(JSON.stringify(wire));
    const channel = routeInfo.kind === 'SMS' ? 'SMS_SIMULATED' : routeInfo.kind === 'MESH' ? 'MESH_SIMULATED' : r.engine.tier === 'TEXT' ? 'TEXT' : 'TEXT+MEDIA';
    const info = { channel, simulated: routeInfo.kind === 'SMS' || routeInfo.kind === 'MESH', via: routeInfo.via ?? null, bytes, tier: r.engine.tier, sentAt: now() };

    if (routeInfo.kind === 'SMS') {
      emitReceiver(rid, 'sms:simulated', { alert: wire, ...info });
      emitOps(r.broadcastId, 'sms:simulated', { receiverId: rid, messageId: m.id, bytes, simulated: true });
      return;
    }
    if (routeInfo.kind === 'MESH') {
      const payload = { from: routeInfo.via, to: rid, messageId: m.id, simulated: true };
      emitOps(r.broadcastId, 'mesh:relay', payload);
      emitReceiver(rid, 'mesh:relay', payload);
      emitReceiver(routeInfo.via, 'mesh:relay', payload);
    }
    emitReceiver(rid, 'alert:received', { alert: wire, ...info });
  };

  const tracked = {
    upsert: async (rec) => store.delivery.upsert(rec),
    update: async (messageId, receiverId, patch) => {
      await store.delivery.update(messageId, receiverId, patch);
      const r = receivers.get(receiverId);
      if (r) emitOps(r.broadcastId, 'delivery:updated', { messageId, receiverId, ...patch });
      if (patch.status === 'DELIVERED' || patch.status === 'ACKED') deliveredKeys.add(`${messageId}::${receiverId}`);
    },
  };

  const tracker = createDeliveryTracker({ store: tracked, send, route, now, ...(backoffMs ? { backoffMs } : {}) });

  const trackFor = (m, r) => {
    if (!inZone(r.location, m.zone)) return false;
    return tracker.track({ id: m.id, priority: m.priority, expiresAtMs: m.expiresAt, wire: m }, r.id).then(() => true);
  };

  // ───────────────────────── metrics pipeline ─────────────────────────
  function processMetrics(r, metrics, simulated, source) {
    const ts = now();
    r.simulated = simulated;
    r.metricSource = source ?? (simulated ? 'simulated' : 'probe');
    r.lastMetrics = metrics;
    r.samples.push({ ts, ...metrics });
    if (r.samples.length > MAX_SAMPLES) r.samples.shift();

    const previousTier = r.engine.tier;
    let { decision, state } = decide(metrics, r.priority, r.engine, engineConfig);
    r.engine = state;

    r.prediction = predictDegradation(r.samples, r.engine.tier, engineConfig);
    if (r.autoPreempt && !decision.changed && r.prediction.recommend) {
      const pre = applyPreemptive(r.engine, r.prediction, metrics, r.priority, engineConfig);
      if (pre) {
        decision = pre.decision;
        r.engine = pre.state;
      }
    }
    r.lastDecision = decision;
    r.health = signalHealthScore(metrics);
    r.quality = broadcastQualityScore({ tier: r.engine.tier, latencyMs: metrics.latencyMs, packetLoss: metrics.packetLoss, stability: metrics.stability });
    r.updatedAt = ts;

    const event = decision.changed ? buildQualityEvent(decision, { at: new Date(ts), receiverId: r.id, broadcastId: r.broadcastId }) : null;
    if (event) {
      store.saveQualityEvent(event);
      store.updateSession(r.sessionId, { lastTier: r.engine.tier });
      const payload = { ...event, at: ts, receiverName: r.name };
      emitOps(r.broadcastId, 'quality:changed', payload);
      emitReceiver(r.id, 'quality:changed', payload);
    }

    if (ts - r.lastPersistedAt >= PERSIST_METRIC_EVERY_MS) {
      r.lastPersistedAt = ts;
      store.saveMetric({ broadcastId: r.broadcastId, receiverId: r.id, ts: new Date(ts), ...metrics, tier: r.engine.tier, healthScore: r.health.score, simulated, source: r.metricSource });
    }

    const view = publicReceiver(r);
    emitOps(r.broadcastId, 'receiver:state', view);
    emitReceiver(r.id, 'receiver:state', { ...view, delivery: decision.delivery, factors: decision.factors, trigger: decision.trigger, held: decision.held });

    // Link restored → retry everything that was held for this receiver.
    if (previousTier === 'CACHED' && r.engine.tier !== 'CACHED') tracker.flush(r.id);
    return decision;
  }

  // ───────────────────────── socket handlers ─────────────────────────
  const fail = (ack, code, message) => typeof ack === 'function' && ack({ ok: false, error: { code, message } });
  const parse = (schema, data, ack) => {
    const r = schema.safeParse(data);
    if (!r.success) {
      fail(ack, 'VALIDATION', r.error.issues[0]?.message ?? 'Invalid payload');
      return null;
    }
    return r.data;
  };

  const isOps = (socket) => socket.user.role === 'broadcaster' || socket.user.role === 'admin';

  /** Receivers are owned by the user that created them; ids are only unique per owner. */
  const ownReceiver = (socket, rid, ack) => {
    const r = receivers.get(rid);
    if (!r) return fail(ack, 'NOT_FOUND', 'Unknown receiver — join first'), null;
    if (r.ownerId !== socket.user.id && socket.user.role !== 'admin') return fail(ack, 'FORBIDDEN', 'That receiver belongs to another user'), null;
    return r;
  };

  async function endReceiver(r, reason) {
    clearTimeout(r.graceTimer);
    tracker.cancelReceiver(r.id);
    receivers.delete(r.id);
    store.updateSession(r.sessionId, { leftAt: new Date(now()), lastTier: r.engine.tier });
    emitOps(r.broadcastId, 'receiver:left', { id: r.id, reason });
  }

  function attach() {
    io.use((socket, next) => {
      try {
        socket.user = verifyToken(socket.handshake.auth?.token ?? '');
        next();
      } catch {
        next(new Error('UNAUTHORIZED'));
      }
    });

    io.on('connection', (socket) => {
      socket.join(rooms.lobby);
      const owned = new Set(); // receiver ids attached to THIS socket
      const lastUpdate = new Map(); // receiverId → last accepted update (per-receiver flood protection)

      socket.on('ops:join', async (data, ack) => {
        if (!isOps(socket)) return fail(ack, 'FORBIDDEN', 'Only broadcasters and admins can watch a broadcast');
        const p = parse(opsJoinSchema, data, ack);
        if (!p) return;
        socket.join(rooms.ops(p.broadcastId));
        ack?.({ ok: true, receivers: [...receivers.values()].filter((r) => r.broadcastId === p.broadcastId).map(publicReceiver) });
      });

      socket.on('ops:leave', (data) => {
        const p = opsJoinSchema.safeParse(data);
        if (p.success) socket.leave(rooms.ops(p.data.broadcastId));
      });

      socket.on('receiver:join', async (data, ack) => {
        const p = parse(joinSchema, data, ack);
        if (!p) return;
        const broadcast = await store.getBroadcast(p.broadcastId);
        if (!broadcast) return fail(ack, 'BROADCAST_NOT_FOUND', 'That broadcast does not exist');
        if (broadcast.status === 'ENDED') return fail(ack, 'BROADCAST_ENDED', 'That broadcast has ended');

        let r = receivers.get(p.receiverId);
        if (r && r.ownerId !== socket.user.id) return fail(ack, 'FORBIDDEN', 'That receiver id is in use by another user');

        const t = now();
        let reconnected = false;
        if (r) {
          // Reconnect (same owner): resume engine state, cancel the grace timer, resync.
          reconnected = true;
          clearTimeout(r.graceTimer);
          if (r.broadcastId !== p.broadcastId) {
            socket.leave(rooms.b(r.broadcastId));
            await endReceiver(r, 'moved');
            r = null;
            reconnected = false;
          }
        }
        if (!r) {
          r = {
            id: p.receiverId, ownerId: socket.user.id, broadcastId: p.broadcastId, name: p.name ?? p.receiverId, language: p.language ?? 'en', location: p.location ?? null,
            status: 'CONNECTED', socketId: socket.id, engine: createEngineState(), samples: [], lastMetrics: null, lastDecision: null, health: null, quality: null, prediction: null,
            simulated: true, autoPreempt: p.autoPreempt ?? true, priority: livePriority(p.broadcastId), reconnects: 0, joinedAt: t, updatedAt: t, lastPersistedAt: 0, graceTimer: null, sessionId: null,
          };
          receivers.set(r.id, r);
          r.sessionId = await store.startSession({ broadcastId: p.broadcastId, receiverId: r.id, userId: socket.user.id, name: r.name, language: r.language, location: r.location ?? undefined, joinedAt: new Date(t) });
        } else {
          r.reconnects += 1;
          r.status = 'CONNECTED';
          r.socketId = socket.id;
          if (p.language) r.language = p.language;
          if (p.location) r.location = p.location;
          store.bumpReconnects(r.sessionId);
        }

        owned.add(r.id);
        socket.join(rooms.b(r.broadcastId));
        socket.join(rooms.r(r.id));

        pruneExpired(r.broadcastId);
        r.priority = livePriority(r.broadcastId);

        emitOps(r.broadcastId, 'receiver:joined', { ...publicReceiver(r), reconnected });
        ack?.({
          ok: true,
          reconnected,
          receiver: publicReceiver(r),
          broadcast: { id: String(broadcast._id), title: broadcast.title, status: broadcast.status, startedAt: broadcast.startedAt ?? null },
          serverTime: now(),
        });

        // Resync: anything live this receiver has not been delivered yet.
        for (const m of activeAlerts.get(r.broadcastId)?.values() ?? []) {
          if (deliveredKeys.has(`${m.id}::${r.id}`)) continue;
          await trackFor(m, r);
        }
        await tracker.flush(r.id);
      });

      socket.on('receiver:update', (data, ack) => {
        const p = parse(updateSchema, data, ack);
        if (!p) return;
        const r = ownReceiver(socket, p.receiverId, ack);
        if (!r) return;
        if (p.language) r.language = p.language;
        if (p.location !== undefined) r.location = p.location;
        if (p.autoPreempt !== undefined) r.autoPreempt = p.autoPreempt;
        emitOps(r.broadcastId, 'receiver:state', publicReceiver(r));
        ack?.({ ok: true, receiver: publicReceiver(r) });
      });

      socket.on('receiver:leave', async (data, ack) => {
        const p = parse(leaveSchema, data, ack);
        if (!p) return;
        const r = ownReceiver(socket, p.receiverId, ack);
        if (!r) return;
        socket.leave(rooms.b(r.broadcastId));
        socket.leave(rooms.r(r.id));
        owned.delete(r.id);
        await endReceiver(r, 'left');
        ack?.({ ok: true });
      });

      socket.on('network:update', (data, ack) => {
        const t = now();
        const key = typeof data?.receiverId === 'string' ? data.receiverId : '';
        if (t - (lastUpdate.get(key) ?? 0) < MIN_UPDATE_INTERVAL_MS) {
          counters.dropped += 1;
          return; // per-receiver flood protection (one socket may drive several receivers)
        }
        lastUpdate.set(key, t);
        if (lastUpdate.size > 64) lastUpdate.delete(lastUpdate.keys().next().value);
        const p = parse(networkSchema, data, ack);
        if (!p) return;
        const r = ownReceiver(socket, p.receiverId, ack);
        if (!r) return;
        counters.updates += 1;
        const decision = processMetrics(r, p.metrics, p.source ? p.source === 'simulated' : p.simulated, p.source);
        ack?.({ ok: true, tier: decision.tier, mode: decision.mode, changed: decision.changed });
      });

      // Broadcaster/admin drives a receiver's simulator remotely (the receiver applies it and reports back).
      socket.on('network:control', (data, ack) => {
        if (!isOps(socket)) return fail(ack, 'FORBIDDEN', 'Only broadcasters and admins can control a simulation');
        const p = parse(controlSchema, data, ack);
        if (!p) return;
        const r = receivers.get(p.receiverId);
        if (!r || r.broadcastId !== p.broadcastId) return fail(ack, 'NOT_FOUND', 'Unknown receiver');
        emitReceiver(r.id, 'network:control', { command: p.command, by: socket.user.name, simulated: true });
        ack?.({ ok: true });
      });

      socket.on('alert:ack', async (data, ack) => {
        const p = parse(alertAckSchema, data, ack);
        if (!p) return;
        const r = ownReceiver(socket, p.receiverId, ack);
        if (!r) return;
        deliveredKeys.add(`${p.messageId}::${r.id}`);
        await tracker.acknowledgeDelivery(p.messageId, r.id);
        ack?.({ ok: true });
      });

      socket.on('alert:response', async (data, ack) => {
        const p = parse(alertResponseSchema, data, ack);
        if (!p) return;
        const r = ownReceiver(socket, p.receiverId, ack);
        if (!r) return;
        const at = new Date(now());
        const location = p.location ?? r.location ?? undefined;
        await store.saveAck({ messageId: p.messageId, broadcastId: r.broadcastId, receiverId: r.id, userId: socket.user.id, status: p.status, location, at });
        await tracker.acknowledgeResponse(p.messageId, r.id);
        emitOps(r.broadcastId, 'ack:created', { messageId: p.messageId, receiverId: r.id, name: r.name, status: p.status, location: location ?? null, at: at.getTime() });
        ack?.({ ok: true });
      });

      socket.on('disconnect', () => {
        for (const rid of owned) {
          const r = receivers.get(rid);
          if (!r || r.socketId !== socket.id) continue; // already re-attached to a newer socket
          r.status = 'DISCONNECTED';
          r.socketId = null;
          emitOps(r.broadcastId, 'receiver:status', { id: r.id, connection: 'DISCONNECTED' });
          r.graceTimer = setTimeout(() => endReceiver(r, 'timeout'), graceMs);
          r.graceTimer.unref?.();
        }
      });
    });
  }

  // ───────────────────────── server-side API (used by REST routes) ─────────────────────────
  /**
   * Fan an emergency message out to a broadcast. Per-receiver routing, zone targeting,
   * supersede handling and CRITICAL retry all happen here.
   * @returns {Promise<{ targeted: number, notTargeted: number, receivers: number }>}
   */
  async function dispatchMessage(message) {
    const bid = message.broadcastId;
    const map = activeAlerts.get(bid) ?? new Map();
    activeAlerts.set(bid, map);

    for (const oldId of message.supersedes ?? []) {
      map.delete(oldId);
      await tracker.cancelMessage(oldId, 'EXPIRED');
      io.to(rooms.b(bid)).emit('alert:superseded', { oldId, newId: message.id });
      emitOps(bid, 'alert:superseded', { oldId, newId: message.id });
    }
    map.set(message.id, message);
    pruneExpired(bid);

    const list = [...receivers.values()].filter((r) => r.broadcastId === bid);
    for (const r of list) r.priority = livePriority(bid);

    emitOps(bid, 'emergency:created', { id: message.id, broadcastId: bid, priority: message.priority, category: message.category, summary: message.translations?.en?.summary ?? '', sentAt: message.sentAt, expiresAt: message.expiresAt, zone: message.zone ?? null, supersedes: message.supersedes ?? [] });

    let targeted = 0;
    for (const r of list) {
      if (await trackFor(message, r)) targeted += 1;
    }
    return { targeted, notTargeted: list.length - targeted, receivers: list.length };
  }

  function broadcastStatus(broadcast, { transition = true } = {}) {
    const payload = { id: String(broadcast._id ?? broadcast.id), title: broadcast.title, status: broadcast.status, startedAt: broadcast.startedAt ?? null, endedAt: broadcast.endedAt ?? null };
    const event = !transition ? null : broadcast.status === 'LIVE' ? 'broadcast:start' : broadcast.status === 'ENDED' ? 'broadcast:stop' : null;
    for (const room of [rooms.b(payload.id), rooms.ops(payload.id)]) {
      if (event) io.to(room).emit(event, payload);
      io.to(room).emit('broadcast:status', payload);
    }
    io.to(rooms.lobby).emit('broadcast:status', payload);
    if (broadcast.status === 'ENDED') activeAlerts.delete(payload.id);
  }

  const getReceivers = (broadcastId) => [...receivers.values()].filter((r) => !broadcastId || r.broadcastId === broadcastId).map(publicReceiver);

  const stats = () => ({
    sockets: io.engine?.clientsCount ?? 0,
    receivers: receivers.size,
    connectedReceivers: [...receivers.values()].filter((r) => r.status === 'CONNECTED').length,
    pendingDeliveries: tracker.pendingCount(),
    updates: counters.updates,
    droppedUpdates: counters.dropped,
  });

  function shutdown() {
    tracker.shutdown();
    for (const r of receivers.values()) clearTimeout(r.graceTimer);
    receivers.clear();
    activeAlerts.clear();
  }

  return { attach, dispatchMessage, broadcastStatus, getReceivers, stats, shutdown, rooms };
}
