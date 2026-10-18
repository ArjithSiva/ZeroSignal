import { describe, expect, it, vi } from 'vitest';
import { createReceiverClient, alertText } from '../src/lib/receiverClient.js';
import { fakeSocket, makeAlert, makeSigner } from './helpers.js';

const signer = makeSigner();
const BID = 'b'.repeat(24);
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(extra = {}) {
  const socket = fakeSocket();
  socket.replies['receiver:join'] = () => ({ ok: true, receiver: { id: 'A', tier: null }, broadcast: { id: BID, title: 'Test', status: 'LIVE' }, serverTime: Date.now() });
  const cache = {
    verifyAlertLanguages: vi.fn(async (signed) => Object.fromEntries(Object.keys(signed).map((l) => [l, 'verified']))),
    saveCriticalAlert: vi.fn(async () => ({ saved: true })),
    readLastVerified: vi.fn(async () => null),
    tamperCachedAlert: vi.fn(),
    ...extra.cache,
  };
  const client = createReceiverClient({ socket, broadcastId: BID, id: 'A', name: 'Test A', tickMs: 10, deps: { cache, measure: extra.measure } });
  return { socket, cache, client };
}

describe('receiver client', () => {
  it('joins and reports simulated metrics', async () => {
    const { socket, client } = setup();
    await client.join();
    expect(client.getSnapshot().status).toBe('joined');
    client.setPreset('POOR');
    await client.tick();
    const upd = socket.sent.find((s) => s.event === 'network:update');
    expect(upd.data.simulated).toBe(true);
    expect(upd.data.metrics.bandwidthKbps).toBeGreaterThan(0);
    expect(upd.data.metrics.bandwidthKbps).toBeLessThan(900);
  });

  it('reports offline metrics when the link is switched off', async () => {
    const { socket, client } = setup();
    await client.join();
    client.setOffline(true);
    await client.tick();
    const m = socket.sent.filter((s) => s.event === 'network:update').at(-1).data.metrics;
    expect(m.online).toBe(false);
    expect(m.bandwidthKbps).toBe(0);
  });

  it('Live Mode reports measured metrics as not simulated', async () => {
    const measure = vi.fn(async () => ({ bandwidthKbps: 5000, latencyMs: 40, packetLoss: 0, jitterMs: 3, stability: 95, online: true }));
    const { socket, client } = setup({ measure });
    await client.join();
    client.setLive(true);
    await client.tick();
    expect(measure).toHaveBeenCalled();
    expect(socket.sent.filter((s) => s.event === 'network:update').at(-1).data.simulated).toBe(false);
  });

  it('verifies, caches, acks and takes over for a CRITICAL alert', async () => {
    const { socket, cache, client } = setup();
    await client.join();
    socket.trigger('alert:received', { alert: makeAlert(signer), channel: 'TEXT', bytes: 400 });
    await flush();
    await flush();
    const s = client.getSnapshot();
    expect(s.alerts[0].verification).toBe('verified');
    expect(cache.saveCriticalAlert).toHaveBeenCalled();
    expect(s.takeover?.id).toBe('a'.repeat(24));
    expect(socket.sent.some((x) => x.event === 'alert:ack')).toBe(true);
  });

  it('never takes over, caches or acks a rejected alert', async () => {
    const { socket, cache, client } = setup({ cache: { verifyAlertLanguages: vi.fn(async () => ({ en: 'rejected' })) } });
    await client.join();
    socket.trigger('alert:received', { alert: makeAlert(signer) });
    await flush();
    await flush();
    expect(client.getSnapshot().alerts[0].verification).toBe('rejected');
    expect(client.getSnapshot().takeover).toBeNull();
    expect(cache.saveCriticalAlert).not.toHaveBeenCalled();
    expect(socket.sent.some((x) => x.event === 'alert:ack')).toBe(false);
  });

  it('clears the takeover when the alert is superseded', async () => {
    const { socket, client } = setup();
    await client.join();
    socket.trigger('alert:received', { alert: makeAlert(signer) });
    await flush();
    await flush();
    socket.trigger('alert:superseded', { oldId: 'a'.repeat(24), newId: 'c'.repeat(24) });
    expect(client.getSnapshot().takeover).toBeNull();
    expect(client.getSnapshot().alerts[0].superseded).toBe(true);
  });

  it('labels SMS and mesh deliveries as simulated', async () => {
    const { socket, client } = setup();
    await client.join();
    socket.trigger('sms:simulated', { alert: makeAlert(signer), bytes: 300 });
    socket.trigger('mesh:relay', { from: 'D', to: 'A', messageId: 'x', simulated: true });
    await flush();
    const s = client.getSnapshot();
    expect(s.alerts[0].channel).toBe('SMS_SIMULATED');
    expect(s.alerts[0].simulated).toBe(true);
    expect(s.feed.every((f) => f.simulated)).toBe(true);
  });

  it('re-joins after a reconnect', async () => {
    const { socket, client } = setup();
    client.start();
    await flush();
    socket.trigger('disconnect');
    expect(client.getSnapshot().status).toBe('reconnecting');
    socket.trigger('connect');
    await flush();
    expect(client.getSnapshot().status).toBe('joined');
    expect(socket.sent.filter((s) => s.event === 'receiver:join')).toHaveLength(2);
    client.dispose();
  });

  it('applies remote network control from a broadcaster', async () => {
    const { socket, client } = setup();
    await client.join();
    socket.trigger('network:control', { command: { preset: 'CRITICAL' } });
    expect(client.getSnapshot().control.preset).toBe('CRITICAL');
  });
});

describe('alertText', () => {
  it('prefers the verified payload in the chosen language, then English', () => {
    const a = makeAlert(signer);
    expect(alertText(a, 'ta').language).toBe('en');
    expect(alertText(a, 'en').headline).toMatch(/Cyclone/);
  });
});

describe('fixed conditions', () => {
  it('pins the simulator to explicit metrics', async () => {
    const { socket, client } = setup();
    await client.join();
    client.setFixed({ bandwidthKbps: 2600, latencyMs: 70, packetLoss: 0.6, jitterMs: 10, stability: 92 });
    await client.tick();
    const m = socket.sent.filter((s) => s.event === 'network:update').at(-1).data.metrics;
    expect(m.bandwidthKbps).toBeGreaterThan(2000);
    expect(m.bandwidthKbps).toBeLessThan(3300);
    expect(client.getSnapshot().control.source).toBe('fixed');
  });
});
