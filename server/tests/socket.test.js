import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BID, GOOD, OFFLINE, TEXT_ONLY, liveMessage, sleep, startServer } from './helpers/realtimeHarness.js';

let s;
beforeEach(async () => {
  s = await startServer();
});
afterEach(async () => {
  await s.close();
});

const join = (c, id, extra = {}) => c.emitAck('receiver:join', { broadcastId: BID, receiverId: id, name: `Receiver ${id}`, ...extra });
const update = async (c, id, metrics) => {
  const r = await c.emitAck('network:update', { receiverId: id, metrics });
  await sleep(50); // respect the per-socket minimum update interval
  return r;
};

describe('authentication', () => {
  it('rejects sockets with no or invalid token', async () => {
    await expect(s.client(s.user(1), { token: '' })).rejects.toThrow(/UNAUTHORIZED/);
    await expect(s.client(s.user(1), { token: 'garbage' })).rejects.toThrow(/UNAUTHORIZED/);
  });
});

describe('join / leave', () => {
  it('a receiver joins, gets a snapshot, and ops see it', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    expect((await ops.emitAck('ops:join', { broadcastId: BID })).receivers).toEqual([]);
    const a = await s.client(s.user(1));
    const ack = await join(a, 'A', { language: 'ta' });
    expect(ack).toMatchObject({ ok: true, reconnected: false, receiver: { id: 'A', language: 'ta', connection: 'CONNECTED' }, broadcast: { status: 'LIVE' } });
    const joined = await ops.waitFor('receiver:joined');
    expect(joined).toMatchObject({ id: 'A', name: 'Receiver A' });
    expect(s.store.log.sessions).toHaveLength(1);
  });

  it('rejects unknown broadcasts, ended broadcasts and malformed payloads', async () => {
    const a = await s.client(s.user(1));
    expect(await a.emitAck('receiver:join', { broadcastId: 'b'.repeat(24), receiverId: 'A' })).toMatchObject({ ok: false, error: { code: 'BROADCAST_NOT_FOUND' } });
    expect(await a.emitAck('receiver:join', { broadcastId: 'nope', receiverId: 'A' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await a.emitAck('receiver:join', { broadcastId: BID, receiverId: 'bad id!' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    await s.close();
    s = await startServer({ store: (await import('./helpers/realtimeHarness.js')).recordingStore({ _id: BID, title: 'x', status: 'ENDED' }) });
    const b = await s.client(s.user(2));
    expect(await join(b, 'A')).toMatchObject({ ok: false, error: { code: 'BROADCAST_ENDED' } });
  });

  it('leaving removes the receiver and tells ops', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    await join(a, 'A');
    expect(await a.emitAck('receiver:leave', { receiverId: 'A' })).toMatchObject({ ok: true });
    expect(await ops.waitFor('receiver:left')).toMatchObject({ id: 'A', reason: 'left' });
    expect(s.rt.getReceivers(BID)).toHaveLength(0);
    expect(s.store.log.sessions[0].leftAt).toBeInstanceOf(Date);
  });

  it('only broadcasters/admins can watch a broadcast', async () => {
    const r = await s.client(s.user(1, 'receiver'));
    expect(await r.emitAck('ops:join', { broadcastId: BID })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const adm = await s.client(s.user(2, 'admin'));
    expect((await adm.emitAck('ops:join', { broadcastId: BID })).ok).toBe(true);
  });

  it('a receiver id cannot be hijacked by another user', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A');
    const intruder = await s.client(s.user(2));
    expect(await join(intruder, 'A')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await intruder.emitAck('network:update', { receiverId: 'A', metrics: GOOD })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await intruder.emitAck('receiver:leave', { receiverId: 'A' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});

describe('network updates and per-receiver isolation', () => {
  it('each receiver gets its own tier from its own network (A 720p, C TEXT)', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    const c = await s.client(s.user(2));
    await join(a, 'A');
    await join(c, 'C');
    expect(await update(a, 'A', GOOD)).toMatchObject({ ok: true, tier: '720p', mode: 'RICH_MEDIA' });
    expect(await update(c, 'C', { ...GOOD, bandwidthKbps: 80, latencyMs: 300 })).toMatchObject({ ok: true, tier: 'TEXT', mode: 'CRITICAL_TEXT' });
    const byId = Object.fromEntries(s.rt.getReceivers(BID).map((r) => [r.id, r]));
    expect(byId.A.tier).toBe('720p');
    expect(byId.C.tier).toBe('TEXT');
    expect(byId.A.health.score).toBeGreaterThan(byId.C.health.score);
  });

  it('degrading one receiver never changes another', async () => {
    const a = await s.client(s.user(1));
    const b = await s.client(s.user(2));
    await join(a, 'A');
    await join(b, 'B');
    await update(a, 'A', GOOD);
    await update(b, 'B', GOOD);
    for (let i = 0; i < 3; i++) await update(b, 'B', TEXT_ONLY);
    const byId = Object.fromEntries(s.rt.getReceivers(BID).map((r) => [r.id, r]));
    expect(byId.B.tier).toBe('TEXT');
    expect(byId.A.tier).toBe('720p');
    expect(s.store.log.events.every((e) => e.receiverId === 'B')).toBe(true);
  });

  it('the server decides the media layer from the engine tier, and records where the metrics came from', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A');
    await update(a, 'A', GOOD);
    let v = s.rt.getReceivers(BID).find((r) => r.id === 'A');
    expect(v.layer).toBe('720p');
    expect(v.metricSource).toBe('simulated');
    for (let i = 0; i < 3; i++) {
      await a.emitAck('network:update', { receiverId: 'A', metrics: TEXT_ONLY, simulated: false, source: 'measured' });
      await sleep(60);
    }
    v = s.rt.getReceivers(BID).find((r) => r.id === 'A');
    expect(v.tier).toBe('TEXT');
    expect(v.layer).toBeNull(); // text-only: no media at all
    expect(v.metricSource).toBe('measured');
    expect(v.simulated).toBe(false);
  });

  it('receivers never see other receivers’ state; ops do', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    const b = await s.client(s.user(2));
    await join(a, 'A');
    await join(b, 'B');
    await update(b, 'B', GOOD);
    await ops.waitFor('receiver:state', (p) => p.id === 'B');
    await sleep(100);
    expect(a.events.filter((e) => e.ev === 'receiver:state')).toHaveLength(0);
    expect(a.events.filter((e) => e.ev === 'quality:changed')).toHaveLength(0);
    expect(b.count('receiver:state')).toBeGreaterThan(0);
  });

  it('a tier change emits quality:changed (with reason + metrics) and persists a quality event', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    await join(a, 'A');
    await update(a, 'A', GOOD);
    await update(a, 'A', TEXT_ONLY); // severe drop → immediate
    const evt = await ops.waitFor('quality:changed', (p) => p.to === 'TEXT');
    expect(evt).toMatchObject({ from: '720p', to: 'TEXT', direction: 'DOWN', trigger: 'REACTIVE', receiverId: 'A' });
    expect(evt.reason.length).toBeGreaterThan(10);
    expect(evt.metrics.bandwidthKbps).toBe(60);
    expect(s.store.log.events.at(-1)).toMatchObject({ to: 'TEXT', broadcastId: BID });
    expect(await a.waitFor('quality:changed')).toBeTruthy(); // the receiver hears about its own change
  });

  it('proactive downgrade: a steady decline triggers a PREDICTIVE switch while bandwidth is still above the reactive threshold', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    await join(a, 'A');
    for (const bw of [16000, 14500, 13000, 11500, 10000, 9000, 8600]) await update(a, 'A', { ...GOOD, bandwidthKbps: bw });
    const pred = await ops.waitFor('quality:changed', (p) => p.trigger === 'PREDICTIVE');
    expect(pred).toMatchObject({ from: '720p', to: '480p', direction: 'DOWN', receiverId: 'A' });
    expect(pred.reason).toMatch(/Degradation predicted/);
    expect(pred.metrics.bandwidthKbps).toBeGreaterThanOrEqual(8000); // reactive threshold not yet crossed
    expect(s.store.log.events.some((e) => e.trigger === 'PREDICTIVE')).toBe(true);
  });

  it('autoPreempt:false keeps the receiver purely reactive', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A', { autoPreempt: false });
    for (const bw of [11000, 10000, 9500, 9000, 8800, 8600, 8400, 8200]) await update(a, 'A', { ...GOOD, bandwidthKbps: bw });
    expect(s.store.log.events.filter((e) => e.trigger === 'PREDICTIVE')).toHaveLength(0);
  });

  it('rejects invalid metrics and floods', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A');
    expect(await a.emitAck('network:update', { receiverId: 'A', metrics: { bandwidthKbps: -5 } })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    await sleep(60);
    expect(await a.emitAck('network:update', { receiverId: 'A', metrics: { bandwidthKbps: 'fast' } })).toMatchObject({ ok: false });
    await sleep(60);
    for (let i = 0; i < 20; i++) a.emit('network:update', { receiverId: 'A', metrics: GOOD });
    await sleep(200);
    expect(s.rt.stats().droppedUpdates).toBeGreaterThan(0);
  });

  it('metrics are persisted at most every 2 s per receiver', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A');
    for (let i = 0; i < 6; i++) await update(a, 'A', GOOD);
    expect(s.store.log.metrics).toHaveLength(1);
    expect(s.store.log.metrics[0]).toMatchObject({ receiverId: 'A', tier: '720p', simulated: true });
  });

  it('network:control is ops-only and reaches only the target receiver', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    const a = await s.client(s.user(1));
    const b = await s.client(s.user(2));
    await join(a, 'A');
    await join(b, 'B');
    expect(await a.emitAck('network:control', { broadcastId: BID, receiverId: 'B', command: { preset: 'POOR' } })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await ops.emitAck('network:control', { broadcastId: BID, receiverId: 'B', command: { preset: 'POOR' } })).toMatchObject({ ok: true });
    expect(await b.waitFor('network:control')).toMatchObject({ command: { preset: 'POOR' }, simulated: true });
    await sleep(80);
    expect(a.count('network:control')).toBe(0);
  });
});

describe('broadcast lifecycle events', () => {
  it('start/stop/status reach receivers, ops and the lobby', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    await join(a, 'A');
    const lobby = await s.client(s.user(3));
    s.rt.broadcastStatus({ _id: BID, title: 'Cyclone', status: 'LIVE', startedAt: new Date() });
    expect(await a.waitFor('broadcast:start')).toMatchObject({ id: BID, status: 'LIVE' });
    expect(await ops.waitFor('broadcast:start')).toBeTruthy();
    expect(await lobby.waitFor('broadcast:status')).toMatchObject({ status: 'LIVE' });
    expect(lobby.count('broadcast:start')).toBe(0); // lobby only gets the light status event
    s.rt.broadcastStatus({ _id: BID, title: 'Cyclone', status: 'ENDED' });
    expect(await a.waitFor('broadcast:stop')).toMatchObject({ status: 'ENDED' });
  });
});

describe('alerts, delivery acknowledgment and retry', () => {
  it('delivers a CRITICAL alert to every receiver, and emergency:created to ops only', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    await join(a, 'A');
    await update(a, 'A', GOOD);
    const res = await s.rt.dispatchMessage(liveMessage('c'.repeat(24)));
    expect(res).toEqual({ targeted: 1, notTargeted: 0, receivers: 1 });
    const got = await a.waitFor('alert:received');
    expect(got.alert).toMatchObject({ id: 'c'.repeat(24), priority: 'CRITICAL', compact: false });
    expect(got.alert.translations.ta.text).toMatch(/[஀-௿]/);
    expect(got.alert.signed.ta.signature).toBeTruthy();
    expect(await ops.waitFor('emergency:created')).toMatchObject({ priority: 'CRITICAL' });
    expect(a.count('emergency:created')).toBe(0);
  });

  it('a TEXT-tier receiver gets the compact (<1 KB per language) signed alert', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A', { language: 'te' });
    await update(a, 'A', { ...GOOD, bandwidthKbps: 80, latencyMs: 300 });
    await s.rt.dispatchMessage(liveMessage('d'.repeat(24)));
    const got = await a.waitFor('alert:received');
    expect(got.alert.compact).toBe(true);
    expect(Object.keys(got.alert.signed).sort()).toEqual(['en', 'te']);
    expect(got.alert.translations).toBeUndefined();
    expect(got.alert.signed.te.bytes).toBeLessThanOrEqual(1024);
    expect(got.channel).toBe('TEXT');
  });

  it('CRITICAL is retried until the receiver acknowledges delivery, then stops', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A');
    await update(a, 'A', GOOD);
    const id = 'e'.repeat(24);
    await s.rt.dispatchMessage(liveMessage(id));
    await a.waitFor('alert:received');
    await sleep(220); // backoff 60ms, 120ms
    expect(a.count('alert:received')).toBeGreaterThanOrEqual(2);
    expect(await a.emitAck('alert:ack', { receiverId: 'A', messageId: id })).toMatchObject({ ok: true });
    await sleep(50);
    const n = a.count('alert:received');
    await sleep(300);
    expect(a.count('alert:received')).toBe(n);
    expect(s.store.log.deliveries.get(`${id}::A`)).toMatchObject({ status: 'DELIVERED' });
  });

  it('geo-targeting: only receivers inside the zone get the alert', async () => {
    const inside = await s.client(s.user(1));
    const outside = await s.client(s.user(2));
    const unknown = await s.client(s.user(3));
    await join(inside, 'IN', { location: { lat: 10.77, lng: 79.84 } });
    await join(outside, 'OUT', { location: { lat: 13.08, lng: 80.27 } });
    await join(unknown, 'UNK');
    for (const [c, id] of [[inside, 'IN'], [outside, 'OUT'], [unknown, 'UNK']]) await update(c, id, GOOD);
    const zone = { lat: 10.7672, lng: 79.8449, radiusKm: 25, label: 'Nagapattinam' };
    const res = await s.rt.dispatchMessage(liveMessage('f'.repeat(24), { zone }));
    expect(res).toEqual({ targeted: 1, notTargeted: 2, receivers: 3 });
    await inside.waitFor('alert:received');
    await sleep(100);
    expect(outside.count('alert:received')).toBe(0);
    expect(unknown.count('alert:received')).toBe(0);
  });

  it('OFFLINE receiver: no live data; CRITICAL raises a SIMULATED SMS and stays pending', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'C');
    await update(a, 'C', GOOD);
    await update(a, 'C', OFFLINE);
    const id = '1'.repeat(24);
    await s.rt.dispatchMessage(liveMessage(id));
    const sms = await a.waitFor('sms:simulated');
    expect(sms).toMatchObject({ channel: 'SMS_SIMULATED', simulated: true });
    expect(sms.alert.compact).toBe(true);
    expect(sms.bytes).toBeLessThan(2100);
    expect(a.count('alert:received')).toBe(0);
    expect(s.store.log.deliveries.get(`${id}::C`).status).toBe('PENDING');
  });

  it('reconnecting after the link returns delivers the held CRITICAL alert', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'C');
    await update(a, 'C', GOOD);
    await update(a, 'C', OFFLINE);
    await s.rt.dispatchMessage(liveMessage('2'.repeat(24)));
    await a.waitFor('sms:simulated');
    for (let i = 0; i < 4; i++) await update(a, 'C', GOOD); // reconnectConfirm samples → leaves CACHED
    const got = await a.waitFor('alert:received', () => true, 3000);
    expect(got.alert.id).toBe('2'.repeat(24));
  });

  it('simulated mesh relay: an offline receiver next to a healthy one is reached via the neighbour', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const good = await s.client(s.user(1));
    const dead = await s.client(s.user(2));
    await join(good, 'D', { location: { lat: 10.769, lng: 79.846 } });
    await join(dead, 'C', { location: { lat: 10.7672, lng: 79.8449 } });
    await update(good, 'D', GOOD);
    await update(dead, 'C', GOOD);
    await update(dead, 'C', OFFLINE);
    await s.rt.dispatchMessage(liveMessage('3'.repeat(24)));
    const relay = await ops.waitFor('mesh:relay');
    expect(relay).toMatchObject({ from: 'D', to: 'C', simulated: true });
    const got = await dead.waitFor('alert:received');
    expect(got.channel).toBe('MESH_SIMULATED');
    expect(got.simulated).toBe(true);
  });

  it('new alerts supersede old ones in the same category', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A');
    await update(a, 'A', GOOD);
    const old = '4'.repeat(24);
    await s.rt.dispatchMessage(liveMessage(old));
    await a.waitFor('alert:received');
    await s.rt.dispatchMessage(liveMessage('5'.repeat(24), { supersedes: [old] }));
    expect(await a.waitFor('alert:superseded')).toMatchObject({ oldId: old, newId: '5'.repeat(24) });
    expect(s.store.log.deliveries.get(`${old}::A`).status).toBe('EXPIRED');
  });

  it('"I’m safe / Need help" is stored and shown to ops', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    await join(a, 'A', { location: { lat: 10.77, lng: 79.84 } });
    await update(a, 'A', GOOD);
    const id = '6'.repeat(24);
    await s.rt.dispatchMessage(liveMessage(id));
    await a.waitFor('alert:received');
    expect(await a.emitAck('alert:response', { receiverId: 'A', messageId: id, status: 'NEED_HELP' })).toMatchObject({ ok: true });
    expect(await ops.waitFor('ack:created')).toMatchObject({ receiverId: 'A', status: 'NEED_HELP', location: { lat: 10.77, lng: 79.84 } });
    expect(s.store.log.acks).toEqual([expect.objectContaining({ status: 'NEED_HELP', receiverId: 'A' })]);
    expect(s.store.log.deliveries.get(`${id}::A`).status).toBe('ACKED');
    expect(await a.emitAck('alert:response', { receiverId: 'A', messageId: id, status: 'MAYBE' })).toMatchObject({ ok: false });
  });

  it('a late joiner is resynced with the active alert; an expired alert is not sent', async () => {
    await s.rt.dispatchMessage(liveMessage('7'.repeat(24)));
    await s.rt.dispatchMessage(liveMessage('8'.repeat(24), { priority: 'HIGH', expiresAt: Date.now() - 1000 }));
    const late = await s.client(s.user(1));
    await join(late, 'L');
    await update(late, 'L', GOOD);
    const got = await late.waitFor('alert:received');
    expect(got.alert.id).toBe('7'.repeat(24));
    await sleep(100);
    expect(late.events.filter((e) => e.ev === 'alert:received').every((e) => e.payload.alert.id === '7'.repeat(24))).toBe(true);
  });
});

describe('reconnection and resync', () => {
  it('a dropped socket becomes DISCONNECTED; rejoining within the grace period keeps engine state', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const u = s.user(1);
    const a = await s.client(u);
    await join(a, 'A');
    await update(a, 'A', GOOD);
    a.close();
    expect(await ops.waitFor('receiver:status')).toMatchObject({ id: 'A', connection: 'DISCONNECTED' });
    const a2 = await s.client(u);
    const ack = await join(a2, 'A');
    expect(ack).toMatchObject({ ok: true, reconnected: true, receiver: { tier: '720p', connection: 'CONNECTED', reconnects: 1 } });
    await sleep(250); // beyond the 150 ms test grace — must NOT be removed
    expect(s.rt.getReceivers(BID)).toHaveLength(1);
  });

  it('no reconnect within the grace period → the receiver is removed and its session closed', async () => {
    const ops = await s.client(s.user(9, 'broadcaster'));
    await ops.emitAck('ops:join', { broadcastId: BID });
    const a = await s.client(s.user(1));
    await join(a, 'A');
    a.close();
    expect(await ops.waitFor('receiver:left', () => true, 1500)).toMatchObject({ id: 'A', reason: 'timeout' });
    expect(s.rt.getReceivers(BID)).toHaveLength(0);
  });

  it('a CRITICAL alert sent while a receiver is disconnected is delivered when it returns', async () => {
    const u = s.user(1);
    const a = await s.client(u);
    await join(a, 'A');
    await update(a, 'A', GOOD);
    a.close();
    await sleep(30);
    await s.rt.dispatchMessage(liveMessage('9'.repeat(24)));
    const a2 = await s.client(u);
    await join(a2, 'A');
    const got = await a2.waitFor('alert:received', () => true, 2000);
    expect(got.alert.id).toBe('9'.repeat(24));
  });

  it('stats expose live counts for the admin health panel', async () => {
    const a = await s.client(s.user(1));
    await join(a, 'A');
    expect(s.rt.stats()).toMatchObject({ receivers: 1, connectedReceivers: 1 });
    expect(s.rt.stats().sockets).toBeGreaterThanOrEqual(1);
  });
});

describe('flood protection is per receiver', () => {
  it('one socket driving several receivers at the same instant loses none of their updates', async () => {
    const c = await s.client(s.user(1));
    for (const id of ['A', 'B', 'C']) await join(c, id);
    const acks = await Promise.all(['A', 'B', 'C'].map((id) => c.emitAck('network:update', { receiverId: id, metrics: GOOD })));
    expect(acks.every((a) => a.ok)).toBe(true);
    expect(s.rt.stats().droppedUpdates).toBe(0);
  });
});
