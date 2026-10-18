/**
 * Delivery receipts & retry (spec §8.13).
 *
 * For every (message, receiver) pair the tracker records a delivery log and, for CRITICAL
 * messages, retries with exponential backoff until the receiver acknowledges receipt or the
 * message expires. The tracker is transport-agnostic: the socket layer supplies `route()`
 * (how to reach this receiver right now) and `emit()` (how to send), and the persistence
 * layer supplies `store`. That keeps it testable without sockets or MongoDB.
 *
 * Honesty rule: a receiver whose SIMULATED link is down (tier CACHED) is never sent live
 * data. CRITICAL alerts for it are held and retried, and a clearly-labelled SIMULATED SMS
 * fallback is raised.
 */

export const BACKOFF_MS = Object.freeze([2000, 4000, 8000, 16000, 30000]);
export const MAX_ATTEMPTS = 8;

/**
 * @typedef {{ kind: 'DIRECT' } | { kind: 'MESH', via: string } | { kind: 'SMS' } | { kind: 'HOLD' }} Route
 *
 * @param {object} deps
 * @param {{ upsert(rec: object): Promise<void>, update(messageId: string, receiverId: string, patch: object): Promise<void> }} deps.store
 * @param {(receiverId: string, route: Route, message: object) => void} deps.send
 * @param {(receiverId: string, message: object) => Route} deps.route
 * @param {() => number} [deps.now]
 * @param {number[]} [deps.backoffMs]
 * @param {number} [deps.maxAttempts]
 */
export function createDeliveryTracker({ store, send, route, now = () => Date.now(), backoffMs = BACKOFF_MS, maxAttempts = MAX_ATTEMPTS }) {
  /** key → { message, receiverId, attempts, timer, done } */
  const pending = new Map();
  const keyOf = (messageId, receiverId) => `${messageId}::${receiverId}`;

  const isExpired = (message) => message.expiresAtMs != null && now() >= message.expiresAtMs;

  const channelFor = (r) => (r.kind === 'SMS' ? 'SMS_SIMULATED' : r.kind === 'MESH' ? 'MESH_SIMULATED' : 'TEXT');

  async function finish(entry, status, patch = {}) {
    entry.done = true;
    clearTimeout(entry.timer);
    pending.delete(keyOf(entry.message.id, entry.receiverId));
    await store.update(entry.message.id, entry.receiverId, { status, ...patch });
  }

  function schedule(entry) {
    const delay = backoffMs[Math.min(entry.attempts - 1, backoffMs.length - 1)];
    entry.timer = setTimeout(() => attempt(entry), delay);
    entry.timer.unref?.();
    return new Date(now() + delay);
  }

  async function attempt(entry) {
    if (entry.done) return;
    const { message, receiverId } = entry;
    if (isExpired(message)) return finish(entry, 'EXPIRED');
    if (entry.attempts >= maxAttempts) return finish(entry, 'EXPIRED', { attempts: entry.attempts });

    const r = route(receiverId, message);
    entry.attempts += 1;

    if (r.kind === 'HOLD') {
      // Deferred (LOW priority on a poor link): do not send, do not retry aggressively.
      await store.update(message.id, receiverId, { status: 'DEFERRED', attempts: entry.attempts });
      if (message.priority === 'CRITICAL' || entry.attempts < 3) {
        const nextRetryAt = schedule(entry);
        await store.update(message.id, receiverId, { nextRetryAt });
      }
      return;
    }

    send(receiverId, r, message);
    const patch = { attempts: entry.attempts, channel: channelFor(r) };

    if (r.kind === 'SMS') {
      // The simulated SMS channel is fire-and-forget; the data link stays down, so we keep
      // retrying the data path for CRITICAL until the receiver actually reconnects and acks.
      if (message.priority === 'CRITICAL') {
        patch.nextRetryAt = schedule(entry);
        await store.update(message.id, receiverId, { ...patch, status: 'PENDING' });
      } else {
        await store.update(message.id, receiverId, { ...patch, status: 'DELIVERED', deliveredAt: new Date(now()) });
        entry.done = true;
        pending.delete(keyOf(message.id, receiverId));
      }
      return;
    }

    if (message.priority === 'CRITICAL') {
      patch.nextRetryAt = schedule(entry); // retry until acked or expired
      await store.update(message.id, receiverId, { ...patch, status: 'PENDING' });
    } else {
      await store.update(message.id, receiverId, { ...patch, status: 'DELIVERED', deliveredAt: new Date(now()) });
      entry.done = true;
      pending.delete(keyOf(message.id, receiverId));
    }
  }

  return {
    /** Begin delivering `message` to a receiver. */
    async track(message, receiverId) {
      const key = keyOf(message.id, receiverId);
      if (pending.has(key)) return;
      await store.upsert({ messageId: message.id, receiverId, priority: message.priority, status: 'PENDING', attempts: 0 });
      const entry = { message, receiverId, attempts: 0, timer: null, done: false };
      pending.set(key, entry);
      await attempt(entry);
    },

    /** The receiver confirmed it holds the alert (delivery acknowledgment). */
    async acknowledgeDelivery(messageId, receiverId) {
      const entry = pending.get(keyOf(messageId, receiverId));
      if (entry) return finish(entry, 'DELIVERED', { deliveredAt: new Date(now()) });
      await store.update(messageId, receiverId, { status: 'DELIVERED', deliveredAt: new Date(now()) });
    },

    /** Receiver tapped "I'm safe / Need help" — final state for the log. */
    async acknowledgeResponse(messageId, receiverId) {
      const entry = pending.get(keyOf(messageId, receiverId));
      if (entry) return finish(entry, 'ACKED', { ackedAt: new Date(now()) });
      await store.update(messageId, receiverId, { status: 'ACKED', ackedAt: new Date(now()) });
    },

    /** The link came back — retry everything still pending for this receiver immediately. */
    async flush(receiverId) {
      const mine = [...pending.values()].filter((e) => e.receiverId === receiverId && !e.done);
      for (const e of mine) {
        clearTimeout(e.timer);
        await attempt(e);
      }
    },

    /** Stop retrying everything for a message (it was superseded or the broadcast ended). */
    async cancelMessage(messageId, status = 'EXPIRED') {
      for (const e of [...pending.values()]) if (e.message.id === messageId) await finish(e, status);
    },

    /** Stop everything for a receiver that left. */
    cancelReceiver(receiverId) {
      for (const e of [...pending.values()]) {
        if (e.receiverId !== receiverId) continue;
        e.done = true;
        clearTimeout(e.timer);
        pending.delete(keyOf(e.message.id, receiverId));
      }
    },

    pendingCount: () => pending.size,
    shutdown() {
      for (const e of pending.values()) clearTimeout(e.timer);
      pending.clear();
    },
  };
}
