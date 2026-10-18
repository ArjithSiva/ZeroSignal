import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { signToken } from '../../src/middleware/auth.js';
import { createRealtime } from '../../src/sockets/realtime.js';
import { createSigner } from '../../src/services/signing.js';
import { SCENARIOS } from '@zerosignal/shared';

export const BID = 'a'.repeat(24);
export const OID = (n) => n.toString(16).padStart(24, '0');

/** In-memory recording store — records writes, never touches MongoDB. */
export function recordingStore(broadcast = { _id: BID, title: 'Test broadcast', status: 'LIVE' }) {
  const log = { metrics: [], events: [], sessions: [], acks: [], deliveries: new Map() };
  return {
    log,
    getBroadcast: async (id) => (id === String(broadcast._id) ? broadcast : null),
    saveMetric: async (m) => log.metrics.push(m),
    saveQualityEvent: async (e) => log.events.push(e),
    startSession: async (s) => (log.sessions.push({ ...s }), `sess${log.sessions.length}`),
    updateSession: async (id, patch) => Object.assign(log.sessions[Number(id.slice(4)) - 1] ?? {}, patch),
    bumpReconnects: async () => {},
    updateBroadcast: async () => {},
    saveAck: async (a) => log.acks.push(a),
    delivery: {
      upsert: async (r) => log.deliveries.set(`${r.messageId}::${r.receiverId}`, { ...r }),
      update: async (m, r, patch) => log.deliveries.set(`${m}::${r}`, { ...log.deliveries.get(`${m}::${r}`), ...patch }),
    },
  };
}

export async function startServer(opts = {}) {
  const store = opts.store ?? recordingStore();
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const rt = createRealtime({ io, store, graceMs: 150, backoffMs: [60, 120], ...opts.rt });
  rt.attach();
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const clients = [];

  const user = (n, role = 'receiver') => ({ _id: OID(n), role, name: `${role}-${n}`, email: `${role}${n}@mail.example.org` });

  const client = (u, { token } = {}) => {
    const c = connect(url, { auth: { token: token ?? signToken(u) }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(c);
    c.events = [];
    c.onAny((ev, payload) => c.events.push({ ev, payload }));
    c.emitAck = (ev, data) => new Promise((res) => c.emit(ev, data, res));
    c.waitFor = (ev, pred = () => true, ms = 2000) =>
      new Promise((res, rej) => {
        const found = c.events.find((e) => e.ev === ev && pred(e.payload));
        if (found) return res(found.payload);
        const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
        const h = (p) => pred(p) && (clearTimeout(t), c.off(ev, h), res(p));
        c.on(ev, h);
      });
    c.count = (ev) => c.events.filter((e) => e.ev === ev).length;
    return new Promise((res, rej) => {
      c.on('connect', () => res(c));
      c.on('connect_error', (e) => rej(e));
    });
  };

  const close = async () => {
    for (const c of clients) c.close();
    rt.shutdown();
    io.close();
    await new Promise((r) => httpServer.close(r));
  };

  return { url, io, rt, store, client, user, close };
}

/** A signed, minimal live message for dispatch. */
export function liveMessage(id, { priority = 'CRITICAL', zone, supersedes, expiresAt = null } = {}) {
  const cyclone = SCENARIOS.cyclone.messages.find((m) => m.priority === 'CRITICAL');
  const signer = createSigner('33'.repeat(32));
  const base = { id, priority, category: 'CYCLONE', issuedAtSec: 1_800_000_000, i18n: cyclone.i18n, zone };
  return {
    id,
    broadcastId: BID,
    priority,
    category: 'CYCLONE',
    confidence: 0.9,
    sentAt: Date.now(),
    expiresAt,
    zone: zone ?? null,
    supersedes: supersedes ?? [],
    translations: Object.fromEntries(Object.entries(cyclone.i18n).map(([k, v]) => [k, { ...v, source: 'preset' }])),
    signed: signer.signMessage(base),
  };
}

export const GOOD = { bandwidthKbps: 12000, latencyMs: 25, packetLoss: 0.1, jitterMs: 4, stability: 98 };
export const TEXT_ONLY = { bandwidthKbps: 60, latencyMs: 800, packetLoss: 14, jitterMs: 140, stability: 20 };
export const OFFLINE = { bandwidthKbps: 0, latencyMs: 0, packetLoss: 100, jitterMs: 0, stability: 0, online: false };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
