import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryTracker } from '../src/services/delivery.js';

function harness({ route = () => ({ kind: 'DIRECT' }), ...opts } = {}) {
  const sent = [];
  const rows = new Map();
  const store = {
    upsert: async (rec) => rows.set(`${rec.messageId}::${rec.receiverId}`, { ...rec }),
    update: async (m, r, patch) => rows.set(`${m}::${r}`, { ...rows.get(`${m}::${r}`), ...patch }),
  };
  const state = { route };
  const tracker = createDeliveryTracker({
    store,
    send: (receiverId, r, message) => sent.push({ receiverId, kind: r.kind, id: message.id }),
    route: (id) => state.route(id),
    ...opts,
  });
  const row = (m, r) => rows.get(`${m}::${r}`);
  return { tracker, sent, row, state };
}

const critical = { id: 'm1', priority: 'CRITICAL', expiresAtMs: null };

describe('delivery tracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('non-critical messages are sent once and marked DELIVERED', async () => {
    const { tracker, sent, row } = harness();
    await tracker.track({ id: 'n1', priority: 'NORMAL' }, 'rA');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(1);
    expect(row('n1', 'rA')).toMatchObject({ status: 'DELIVERED', attempts: 1, channel: 'TEXT' });
    expect(tracker.pendingCount()).toBe(0);
  });

  it('CRITICAL is retried with exponential backoff until acknowledged', async () => {
    const { tracker, sent, row } = harness();
    await tracker.track(critical, 'rA');
    expect(sent).toHaveLength(1);
    expect(row('m1', 'rA').status).toBe('PENDING');

    await vi.advanceTimersByTimeAsync(2000); // 1st backoff 2s
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3999); // 2nd backoff 4s — not yet
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(8000); // 3rd backoff 8s
    expect(sent).toHaveLength(4);

    await tracker.acknowledgeDelivery('m1', 'rA');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(4); // no more retries
    expect(row('m1', 'rA')).toMatchObject({ status: 'DELIVERED' });
    expect(tracker.pendingCount()).toBe(0);
  });

  it('CRITICAL expires when its expiry passes, and stops retrying', async () => {
    let t = 0;
    const { tracker, sent, row } = harness({ now: () => t });
    await tracker.track({ id: 'm2', priority: 'CRITICAL', expiresAtMs: 5000 }, 'rA');
    t = 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(2);
    t = 6000; // past expiry
    await vi.advanceTimersByTimeAsync(4000);
    expect(row('m2', 'rA').status).toBe('EXPIRED');
    const n = sent.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(n);
  });

  it('gives up after the maximum number of attempts', async () => {
    const { tracker, sent, row } = harness({ maxAttempts: 3, backoffMs: [10] });
    await tracker.track(critical, 'rA');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(3);
    expect(row('m1', 'rA').status).toBe('EXPIRED');
  });

  it('never delivers live data to a receiver whose simulated link is down; raises SIMULATED SMS instead', async () => {
    const { tracker, sent, row } = harness({ route: () => ({ kind: 'SMS' }) });
    await tracker.track(critical, 'rC');
    expect(sent).toEqual([{ receiverId: 'rC', kind: 'SMS', id: 'm1' }]);
    expect(sent.some((s) => s.kind === 'DIRECT')).toBe(false);
    expect(row('m1', 'rC')).toMatchObject({ channel: 'SMS_SIMULATED', status: 'PENDING' }); // still pending: not "delivered"
  });

  it('CRITICAL is never dropped: keeps retrying while offline, then delivers on flush', async () => {
    const { tracker, sent, row, state } = harness({ route: () => ({ kind: 'SMS' }) });
    await tracker.track(critical, 'rC');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tracker.pendingCount()).toBe(1);

    state.route = () => ({ kind: 'DIRECT' }); // link restored
    await tracker.flush('rC');
    expect(sent.at(-1)).toMatchObject({ kind: 'DIRECT' });
    await tracker.acknowledgeDelivery('m1', 'rC');
    expect(row('m1', 'rC').status).toBe('DELIVERED');
  });

  it('mesh relay is a distinct, labelled channel', async () => {
    const { tracker, sent, row } = harness({ route: () => ({ kind: 'MESH', via: 'rA' }) });
    await tracker.track({ id: 'n2', priority: 'HIGH' }, 'rC');
    expect(sent[0].kind).toBe('MESH');
    expect(row('n2', 'rC').channel).toBe('MESH_SIMULATED');
  });

  it('LOW priority on a poor link is held (deferred), not sent', async () => {
    const { tracker, sent, row } = harness({ route: () => ({ kind: 'HOLD' }) });
    await tracker.track({ id: 'l1', priority: 'LOW' }, 'rC');
    expect(sent).toHaveLength(0);
    expect(row('l1', 'rC').status).toBe('DEFERRED');
  });

  it('is isolated per receiver', async () => {
    const { tracker, sent } = harness();
    await tracker.track(critical, 'rA');
    await tracker.track(critical, 'rB');
    await tracker.acknowledgeDelivery('m1', 'rA');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent.filter((s) => s.receiverId === 'rA')).toHaveLength(1);
    expect(sent.filter((s) => s.receiverId === 'rB')).toHaveLength(2);
  });

  it('does not double-track the same pair', async () => {
    const { tracker, sent } = harness();
    await tracker.track(critical, 'rA');
    await tracker.track(critical, 'rA');
    expect(sent).toHaveLength(1);
  });

  it('cancelMessage (superseded) stops retries; cancelReceiver (left) stops that receiver only', async () => {
    const { tracker, sent, row } = harness();
    await tracker.track(critical, 'rA');
    await tracker.track(critical, 'rB');
    tracker.cancelReceiver('rA');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent.filter((s) => s.receiverId === 'rA')).toHaveLength(1);
    expect(sent.filter((s) => s.receiverId === 'rB')).toHaveLength(2);
    await tracker.cancelMessage('m1', 'EXPIRED');
    expect(row('m1', 'rB').status).toBe('EXPIRED');
    expect(tracker.pendingCount()).toBe(0);
  });

  it("the receiver's 'I'm safe' response finalises the log as ACKED", async () => {
    const { tracker, row } = harness();
    await tracker.track(critical, 'rA');
    await tracker.acknowledgeResponse('m1', 'rA');
    expect(row('m1', 'rA').status).toBe('ACKED');
  });
});
