import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { createLimiters } from '../src/middleware/rateLimit.js';
import { loadConfig } from '../src/config/env.js';
import { signToken } from '../src/middleware/auth.js';
import { createAiService } from '../src/services/ai.js';
import { createGroqClient } from '../src/services/groq.js';
import { createSigner } from '../src/services/signing.js';

// Fail fast instead of buffering when a handler (incorrectly) reaches for the database.
mongoose.set('bufferCommands', false);

const cfg = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), CLIENT_ORIGINS: 'https://app.zerosignal.test' });
const signer = createSigner('55'.repeat(32));
const ai = createAiService(createGroqClient({ apiKey: '', model: 'm', timeoutMs: 100, baseUrl: 'http://x' }));
const realtime = { broadcastStatus() {}, getReceivers: () => [], stats: () => ({ sockets: 0, receivers: 0 }), dispatchMessage: async () => ({}) };

const make = (limits = {}, config = cfg) => createApp({ config, ai, signer, realtime, limiters: createLimiters({ windowMs: 60_000, max: 1000, authMax: 1000, aiMax: 1000, ...limits }) });
const tokenFor = (role, extra = {}) => signToken({ _id: 'a'.repeat(24), role, name: role, email: `${role}@mail.example.org`, ...extra }, cfg);
const bearer = (role) => ({ Authorization: `Bearer ${tokenFor(role)}` });
const VALID_ID = 'b'.repeat(24);

let app;
beforeAll(() => {
  app = make();
});
afterEach(() => vi.restoreAllMocks());

describe('authentication (JWT)', () => {
  const protectedRoutes = [
    ['get', '/api/auth/me'], ['get', '/api/broadcasts'], ['post', '/api/broadcasts'], ['get', `/api/broadcasts/${VALID_ID}`], ['get', '/api/emergency'], ['post', '/api/emergency/analyze'],
    ['post', '/api/ai/summarize'], ['get', '/api/analytics/global'], ['get', '/api/admin/health'], ['get', '/api/admin/users'], ['get', '/api/admin/audit'], ['post', '/api/network/metrics'],
  ];

  it.each(protectedRoutes)('%s %s → 401 without a token', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed, tampered, expired, wrong-secret and alg:none tokens', async () => {
    const good = tokenFor('admin');
    const [h, p, s] = good.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'a'.repeat(24), role: 'admin', name: 'x', email: 'x@x' })).toString('base64url');
    const attempts = {
      'garbage': 'Bearer not-a-jwt',
      'wrong scheme': `Basic ${good}`,
      'tampered payload': `Bearer ${h}.${forgedPayload}.${s}`,
      'wrong secret': `Bearer ${jwt.sign({ sub: 'a'.repeat(24), role: 'admin' }, 'another-secret-another-secret-12345', { algorithm: 'HS256' })}`,
      'expired': `Bearer ${jwt.sign({ sub: 'a'.repeat(24), role: 'admin' }, cfg.jwtSecret, { algorithm: 'HS256', expiresIn: -10 })}`,
      'alg none': `Bearer ${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${forgedPayload}.`,
      'HS512 (algorithm pinned to HS256)': `Bearer ${jwt.sign({ sub: 'a'.repeat(24), role: 'admin' }, cfg.jwtSecret, { algorithm: 'HS512' })}`,
    };
    for (const [name, header] of Object.entries(attempts)) {
      const res = await request(app).get('/api/admin/health').set('Authorization', header);
      expect(res.status, name).toBe(401);
    }
  });

  it('error responses never include stack traces', async () => {
    const res = await request(app).get('/api/admin/health');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\(.*:\d+:\d+\)|node_modules/);
  });
});

describe('role-based authorization', () => {
  const cases = [
    // [method, path, roles that must be refused]
    ['post', '/api/broadcasts', ['receiver']],
    ['post', `/api/broadcasts/${VALID_ID}/start`, ['receiver']],
    ['post', `/api/broadcasts/${VALID_ID}/stop`, ['receiver']],
    ['delete', `/api/broadcasts/${VALID_ID}`, ['receiver']],
    ['get', `/api/broadcasts/${VALID_ID}/receivers`, ['receiver']],
    ['get', `/api/broadcasts/${VALID_ID}/timeline`, ['receiver']],
    ['get', `/api/broadcasts/${VALID_ID}/report`, ['receiver']],
    ['post', '/api/emergency', ['receiver']],
    ['post', '/api/emergency/analyze', ['receiver']],
    ['post', `/api/emergency/${VALID_ID}/translate`, ['receiver']],
    ['post', '/api/ai/summarize', ['receiver']],
    ['post', '/api/ai/translate', ['receiver']],
    ['get', '/api/analytics/global', ['receiver']],
    ['get', '/api/admin/health', ['receiver', 'broadcaster']],
    ['get', '/api/admin/users', ['receiver', 'broadcaster']],
    ['post', '/api/admin/users', ['receiver', 'broadcaster']],
    ['get', '/api/admin/audit', ['receiver', 'broadcaster']],
    ['patch', `/api/admin/users/${VALID_ID}/active`, ['receiver', 'broadcaster']],
    ['post', `/api/admin/users/${VALID_ID}/invite`, ['receiver', 'broadcaster']],
    ['patch', `/api/admin/users/${VALID_ID}/role`, ['receiver', 'broadcaster']],
  ];

  for (const [method, path, roles] of cases) {
    for (const role of roles) {
      it(`${role} → 403 on ${method.toUpperCase()} ${path}`, async () => {
        const res = await request(app)[method](path).set(bearer(role)).send({});
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      });
    }
  }

  it('allowed roles get past the role check (and fail later, on validation, not on authorization)', async () => {
    for (const [role, path] of [['broadcaster', '/api/emergency/analyze'], ['admin', '/api/emergency/analyze'], ['admin', '/api/admin/users']]) {
      const res = await request(app).post(path).set(bearer(role)).send({});
      expect(res.status, `${role} ${path}`).toBe(400);
    }
  });
});

describe('input validation', () => {
  it('rejects malformed login bodies', async () => {
    for (const body of [{}, { email: 'nope', password: 'x' }, { email: 'a@b.co' }, { email: 'a@b.co', password: '' }, { email: 'a@b.co', password: 'x'.repeat(500) }, { email: ['a@b.co'], password: 'x' }]) {
      const res = await request(app).post('/api/auth/login').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    }
  });

  it('returns field-level validation details', async () => {
    const res = await request(app).post('/api/broadcasts').set(bearer('broadcaster')).send({ title: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({ path: 'title' });
  });

  it('rejects invalid ObjectIds in params and queries', async () => {
    expect((await request(app).get('/api/broadcasts/not-an-id').set(bearer('admin'))).status).toBe(400);
    expect((await request(app).get('/api/emergency?broadcastId=zzz').set(bearer('admin'))).status).toBe(400);
    expect((await request(app).get('/api/analytics/broadcasts/12345').set(bearer('admin'))).status).toBe(400);
  });

  it('rejects out-of-range enums and numbers on emergency creation', async () => {
    const base = { broadcastId: VALID_ID, original: 'Cyclone landfall tonight. Evacuate now.', priority: 'CRITICAL', category: 'CYCLONE', summary: 'Evacuate', recommendedAction: 'Go to shelter' };
    expect((await request(app).post('/api/emergency').set(bearer('broadcaster')).send({ ...base, priority: 'EXTREME' })).status).toBe(400);
    expect((await request(app).post('/api/emergency').set(bearer('broadcaster')).send({ ...base, category: 'ALIENS' })).status).toBe(400);
    expect((await request(app).post('/api/emergency').set(bearer('broadcaster')).send({ ...base, translateTo: ['fr'] })).status).toBe(400);
    expect((await request(app).post('/api/emergency').set(bearer('broadcaster')).send({ ...base, expiresInMinutes: 99999999 })).status).toBe(400);
    expect((await request(app).post('/api/emergency').set(bearer('broadcaster')).send({ ...base, zone: { lat: 999, lng: 0, radiusKm: 5 } })).status).toBe(400);
    expect((await request(app).post('/api/emergency').set(bearer('broadcaster')).send({ ...base, original: 'short' })).status).toBe(400);
  });

  it('rejects an oversized text announcement and oversized request bodies', async () => {
    expect((await request(app).post('/api/emergency/analyze').set(bearer('broadcaster')).send({ text: 'x'.repeat(4001) })).status).toBe(400);
    const big = await request(app).post('/api/emergency/analyze').set(bearer('broadcaster')).send({ text: 'x'.repeat(100_000) });
    expect(big.status).toBe(413);
  });

  it('rejects invalid JSON with a clean 400', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_JSON');
  });

  it('rejects network ingest with bad samples', async () => {
    const h = bearer('broadcaster');
    expect((await request(app).post('/api/network/metrics').set(h).send({ broadcastId: VALID_ID, samples: [] })).status).toBe(400);
    expect((await request(app).post('/api/network/metrics').set(h).send({ broadcastId: VALID_ID, samples: [{ receiverId: 'A', bandwidthKbps: -1 }] })).status).toBe(400);
    expect((await request(app).post('/api/network/metrics').set(h).send({ broadcastId: VALID_ID, samples: Array(201).fill({ receiverId: 'A', bandwidthKbps: 5 }) })).status).toBe(400);
  });

  it('strips unknown fields instead of passing them to handlers', async () => {
    const res = await request(app).post('/api/emergency/analyze').set(bearer('broadcaster')).send({ text: 'Cyclone landfall tonight. Evacuate now.', isAdmin: true, $where: '1' });
    expect(res.status).toBe(200); // fallback AI worked; extra fields ignored
    expect(res.body.meta.fallback).toBe(true);
  });
});

describe('NoSQL injection and prototype pollution', () => {
  it('operator objects in login fields are neutralised before reaching a query', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
  });

  it('operator keys in query strings are dropped', async () => {
    const res = await request(app).get('/api/emergency').set(bearer('admin')).query('priority[$ne]=x');
    expect(res.status).toBe(400); // priority became {} → fails enum validation, never reaches Mongo
  });

  it('prototype-pollution payloads do nothing', async () => {
    await request(app).post('/api/emergency/analyze').set(bearer('broadcaster')).set('Content-Type', 'application/json').send('{"__proto__":{"polluted":true},"text":"Cyclone landfall tonight. Evacuate now."}');
    expect({}.polluted).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('auth routes are limited (429 after the allowance, with the standard error shape)', async () => {
    const a = make({ authMax: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await request(a).post('/api/auth/login').send({})).status);
    expect(codes).toEqual([400, 400, 400, 429, 429]);
    const res = await request(a).post('/api/auth/login').send({});
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['ratelimit']).toBeDefined();
  });

  it('AI routes are limited independently of auth routes', async () => {
    const a = make({ aiMax: 2 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await request(a).post('/api/emergency/analyze').set(bearer('broadcaster')).send({ text: 'Cyclone landfall tonight. Evacuate now.' })).status);
    expect(codes).toEqual([200, 200, 429, 429]);
    expect((await request(a).post('/api/auth/login').send({})).status).toBe(400); // auth limiter unaffected
  });

  it('the general limiter covers every /api route, including the health ping', async () => {
    const a = make({ max: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await request(a).get('/api/health')).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('the AI limiter does not apply to the rest of the API', async () => {
    const a = make({ aiMax: 1 });
    for (let i = 0; i < 5; i++) expect((await request(a).get('/api/alerts/public-key')).status).toBe(200);
  });
});

describe('CORS and secure headers', () => {
  it('allows only configured origins', async () => {
    const ok = await request(app).get('/api/health').set('Origin', 'https://app.zerosignal.test');
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.zerosignal.test');
    const bad = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(bad.status).toBe(403);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight only for allowed origins', async () => {
    const ok = await request(app).options('/api/broadcasts').set('Origin', 'https://app.zerosignal.test').set('Access-Control-Request-Method', 'POST');
    expect(ok.status).toBe(204);
    const bad = await request(app).options('/api/broadcasts').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets Helmet headers and hides the framework', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});

describe('error handling', () => {
  it('unknown routes → JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('production 500s never leak internals (no stack, no driver message, no debug field)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const prod = loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://secret-user:secret-pass@db.internal/x', JWT_SECRET: 'x'.repeat(40), ALERT_SIGNING_SEED: 'a'.repeat(64), CLIENT_ORIGINS: 'https://app.zerosignal.test' });
    const a = make({}, prod);
    const token = signToken({ _id: 'a'.repeat(24), role: 'admin', name: 'a', email: 'a@mail.example.org' }, prod);
    const res = await request(a).get(`/api/broadcasts/${VALID_ID}`).set('Authorization', `Bearer ${token}`); // reaches Mongoose, which has no connection
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(body).not.toMatch(/secret-pass|secret-user|db\.internal|node_modules|at .*:\d+:\d+|debug|buffering|Mongo/i);
  });

  it('no seed, reset or demo-login capability exists in the API, even for an admin', async () => {
    for (const [method, path] of [['post', '/api/admin/seed'], ['post', '/api/admin/reset'], ['post', '/api/admin/clean'], ['get', '/api/admin/seed-status'], ['post', '/api/auth/demo']]) {
      const res = await request(app)[method](path).set(bearer('admin')).send({ role: 'admin' });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('route audit: nothing mounted on the app can seed, wipe or reset the database', () => {
    const paths = [];
    const walk = (stack, prefix = '') => {
      for (const l of stack) {
        if (l.route) paths.push(...Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${l.route.path}`));
        else if (l.handle?.stack) walk(l.handle.stack, prefix + (l.regexp?.source.includes('\\/api') ? '' : ''));
      }
    };
    walk(app._router.stack);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.filter((p) => /seed|reset(?!-password)|wipe|purge|drop|demo/i.test(p))).toEqual([]);
  });
});

describe('public endpoints', () => {
  it('health reports status without exposing configuration', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'zerosignal-api', db: 'down' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|key|uri|mongodb/i);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('publishes only the public signing key, and verifies/rejects signatures', async () => {
    const pk = await request(app).get('/api/alerts/public-key');
    expect(pk.body).toMatchObject({ algorithm: 'Ed25519', publicKey: signer.publicKeyB64 });
    const payload = { v: 1, id: 'x', h: 'Evacuate' };
    const signature = signer.sign(payload);
    expect((await request(app).post('/api/alerts/verify').send({ payload, signature })).body.valid).toBe(true);
    expect((await request(app).post('/api/alerts/verify').send({ payload: { ...payload, h: 'Stay' }, signature })).body.valid).toBe(false);
    expect((await request(app).post('/api/alerts/verify').send({ payload, signature: 'x'.repeat(10) })).body.valid).toBe(false);
    expect((await request(app).post('/api/alerts/verify').send({ nope: 1 })).status).toBe(400);
  });

  it('network probes are tiny and capped', async () => {
    expect((await request(app).get('/api/network/probe')).body.t).toBeTypeOf('number');
    const p = await request(app).get('/api/network/payload?kb=8').buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(p.body.length).toBe(8 * 1024);
    expect((await request(app).get('/api/network/payload?kb=100000')).status).toBe(400);
  });
});
