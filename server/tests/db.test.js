/**
 * Database-backed suite. Runs automatically against mongodb-memory-server (downloads a mongod binary
 * on first use) or MONGODB_URI_TEST, and in CI against a service container. If neither is reachable the
 * tests skip loudly (see helpers/mongo.js) instead of failing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { startTestMongo } from './helpers/mongo.js';
import { ALL_MODELS, AuditLog, AuthToken, Broadcast, RefreshToken, User } from '../src/models/index.js';
import { cleanSeed, runSeed, seedStatus } from '../src/seed/index.js';
import { buildSeedDataset } from '../src/seed/dataset.js';
import { createApp } from '../src/app.js';
import { createAiService } from '../src/services/ai.js';
import { createGroqClient } from '../src/services/groq.js';
import { getSigner } from '../src/services/signing.js';
import { loadConfig } from '../src/config/env.js';
import { createAccountService } from '../src/services/auth/accounts.js';
import { createMongoAccountRepos } from '../src/services/auth/accountRepos.js';
import { createHasher } from '../src/services/auth/passwords.js';
import { createMailer } from '../src/services/auth/mailer.js';

const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const SEED = { emailDomain: 'responders.example.org', password: 'Granite-Lantern-4471', argon2: FAST };
const config = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), MAIL_TRANSPORT: 'memory', ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '1' });

let mongo;
beforeAll(async () => {
  mongo = await startTestMongo();
  if (mongo.available) await Promise.all(Object.values(ALL_MODELS).concat([RefreshToken, AuthToken, AuditLog]).map((M) => M.syncIndexes()));
});
afterAll(async () => mongo?.stop());

const counts = async () => Object.fromEntries(await Promise.all(Object.entries(ALL_MODELS).map(async ([k, M]) => [k, await M.countDocuments()])));
const wipe = async () => {
  await Promise.all(Object.values(ALL_MODELS).concat([RefreshToken, AuthToken, AuditLog]).map((M) => M.deleteMany({})));
};

describe('seed system (CLI path)', () => {
  beforeEach(async (ctx) => {
    if (!mongo.available) return ctx.skip();
    await wipe();
  });

  it('seeds a complete database', async () => {
    const { inserted, users } = await runSeed(SEED);
    expect(users.length).toBeGreaterThanOrEqual(5);
    expect(users.every((u) => u.email.endsWith('@responders.example.org'))).toBe(true);
    const s = await seedStatus();
    expect(s.counts.broadcasts).toBeGreaterThanOrEqual(5);
    expect(s.counts.messages).toBeGreaterThanOrEqual(10);
    expect(s.counts.metrics).toBeGreaterThanOrEqual(300);
    expect(inserted.users).toBe(users.length);
  });

  it('re-seeding is idempotent: identical counts, no duplicate users or messages', async () => {
    await runSeed(SEED);
    const first = await counts();
    await runSeed(SEED);
    await runSeed(SEED);
    expect(await counts()).toEqual(first);
    expect(await User.countDocuments({ email: `asha.raman@${SEED.emailDomain}` })).toBe(1);
    const ids = (await ALL_MODELS.EmergencyMessage.find({}, { _id: 1 }).lean()).map((d) => String(d._id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('seedBatchId is never returned by any query, lean or not, and passwordHash stays hidden', async () => {
    await runSeed(SEED);
    for (const M of Object.values(ALL_MODELS)) {
      const lean = await M.findOne().lean();
      const doc = (await M.findOne())?.toJSON();
      for (const d of [lean, doc]) {
        expect(d, M.modelName).toBeTruthy();
        expect(Object.keys(d)).not.toContain('seedBatchId');
        expect(Object.keys(d)).not.toContain('isSeed');
        expect(Object.keys(d)).not.toContain('passwordHash');
      }
    }
  });

  it('clean removes exactly the seeded documents and leaves real data alone', async () => {
    const real = await User.create({ name: 'Real Person', email: 'real.person@mail.example.org', passwordHash: 'x', role: 'receiver' });
    const realBroadcast = await Broadcast.create({ title: 'Real broadcast', status: 'ENDED' });
    await runSeed(SEED);
    const removed = await cleanSeed();
    expect(removed.users).toBeGreaterThanOrEqual(5);
    expect(await User.findById(real._id)).toBeTruthy();
    expect(await Broadcast.findById(realBroadcast._id)).toBeTruthy();
    expect(await counts()).toMatchObject({ User: 1, Broadcast: 1, EmergencyMessage: 0, NetworkMetric: 0 });
    await runSeed(SEED);
    expect((await seedStatus()).counts.broadcasts).toBeGreaterThanOrEqual(5);
  });

  it('refuses to take over a real account that already uses a seeded address', async () => {
    await User.create({ name: 'Real Asha', email: `asha.raman@${SEED.emailDomain}`, passwordHash: 'x', role: 'receiver' });
    await expect(runSeed(SEED)).rejects.toThrow(/already belong to real accounts/);
    expect((await User.findOne({ email: `asha.raman@${SEED.emailDomain}` })).name).toBe('Real Asha');
  });

  it('seeded documents satisfy the Mongoose schemas', async () => {
    const data = buildSeedDataset({ now: Date.now(), passwordHash: 'x', emailDomain: SEED.emailDomain, signer: getSigner() });
    for (const [key, Model] of [['users', User], ['broadcasts', ALL_MODELS.Broadcast], ['messages', ALL_MODELS.EmergencyMessage], ['events', ALL_MODELS.QualityEvent], ['deliveries', ALL_MODELS.DeliveryLog], ['acks', ALL_MODELS.Acknowledgment], ['aiUsage', ALL_MODELS.AiUsage], ['sessions', ALL_MODELS.ReceiverSession], ['metrics', ALL_MODELS.NetworkMetric]]) {
      for (const doc of data[key].slice(0, 25)) await new Model(doc).validate();
    }
  });
});

describe('account repositories against MongoDB (the thin Mongoose layer)', () => {
  const build = () => {
    const repos = createMongoAccountRepos();
    const mailer = createMailer(config.mail);
    return { repos, mailer, svc: createAccountService({ repos, config, mailer, hasher: createHasher(FAST) }) };
  };
  const ctx = { ip: '203.0.113.5', userAgent: 'vitest' };
  const PW = 'Tr1cky-Harbour-Lamp';
  beforeEach(async (c) => {
    if (!mongo.available) return c.skip();
    await wipe();
  });

  it('register → login → refresh rotation → reuse detection → logout, persisted in MongoDB', async () => {
    const { svc } = build();
    const s1 = await svc.register({ name: 'Priya Natarajan', email: 'priya@mail.example.org', password: PW }, ctx);
    expect(await User.countDocuments({ email: 'priya@mail.example.org' })).toBe(1);
    const stored = await RefreshToken.findOne().lean();
    expect(stored.tokenHash).not.toBe(s1.refreshToken);
    expect(JSON.stringify(stored)).not.toContain(s1.refreshToken);

    const login = await svc.login({ email: 'priya@mail.example.org', password: PW }, ctx);
    const s2 = await svc.refresh(login.refreshToken, ctx);
    expect(s2.refreshToken).not.toBe(login.refreshToken);
    await RefreshToken.updateMany({ rotatedAt: { $exists: true } }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } }); // age past the grace window
    await expect(svc.refresh(login.refreshToken, ctx)).rejects.toMatchObject({ status: 401 });
    await expect(svc.refresh(s2.refreshToken, ctx)).rejects.toMatchObject({ status: 401 }); // family revoked
    expect(await AuditLog.countDocuments({ type: 'TOKEN_REUSE_DETECTED' })).toBe(1);
  });

  it('lockout, reset and invite persist correctly; secrets are never stored raw', async () => {
    const { svc, mailer } = build();
    await svc.register({ name: 'Priya N', email: 'priya@mail.example.org', password: PW }, ctx);
    for (let i = 0; i < 5; i++) await svc.login({ email: 'priya@mail.example.org', password: 'bad-password-1' }, ctx).catch(() => {});
    await expect(svc.login({ email: 'priya@mail.example.org', password: PW }, ctx)).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });

    await svc.forgotPassword('priya@mail.example.org', ctx);
    const token = new URL(mailer.outbox[0].text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    expect(JSON.stringify(await AuthToken.find().lean())).not.toContain(token);
    await svc.resetPassword({ token, newPassword: 'Fresh-Reset-Pass7' }, ctx);
    expect((await svc.login({ email: 'priya@mail.example.org', password: 'Fresh-Reset-Pass7' }, ctx)).user.role).toBe('receiver');

    const admin = (await User.findOne({ email: 'priya@mail.example.org' }))._id.toString();
    const { inviteUrl } = await svc.createAccount({ id: admin }, { name: 'Karthik Rao', email: 'karthik@mail.example.org', role: 'broadcaster' }, ctx);
    const done = await svc.completeInvite({ token: new URL(inviteUrl).searchParams.get('token'), newPassword: 'Granite-Strong-Pass3' }, ctx);
    expect(done.user.role).toBe('broadcaster');
  });

  it('TTL indexes exist for refresh tokens, auth tokens and the audit log', async () => {
    for (const M of [RefreshToken, AuthToken, AuditLog]) {
      const idx = await M.collection.indexes();
      expect(idx.some((i) => i.expireAfterSeconds != null), M.modelName).toBe(true);
    }
  });

  it('TOTP secrets are sealed at rest', async () => {
    const { svc } = build();
    const admin = { id: 'a'.repeat(24) };
    const { inviteUrl } = await svc.createAccount(admin, { name: 'Asha R', email: 'asha@mail.example.org', role: 'admin' }, ctx);
    const s = await svc.completeInvite({ token: new URL(inviteUrl).searchParams.get('token'), newPassword: 'Harbour-Strong-Pass5' }, ctx);
    const { secret } = await svc.begin2fa(s.user.id);
    const raw = await User.findById(s.user.id).select('+totp').lean();
    expect(JSON.stringify(raw.totp)).not.toContain(secret);
  });
});

describe('API end-to-end against a real database', () => {
  const ai = createAiService(createGroqClient({ apiKey: '', model: 'm', timeoutMs: 100, baseUrl: 'http://x' }));
  const dispatched = [];
  const realtime = { broadcastStatus() {}, getReceivers: () => [], stats: () => ({ sockets: 0, receivers: 0, connectedReceivers: 0, pendingDeliveries: 0 }), dispatchMessage: async (m) => (dispatched.push(m), { targeted: 0, notTargeted: 0, receivers: 0 }) };
  const app = () => createApp({ config, ai, signer: getSigner(), realtime });
  const login = async (a, local) => (await request(a).post('/api/auth/login').send({ email: `${local}@${SEED.emailDomain}`, password: SEED.password })).body.token;
  const asha = (a) => login(a, 'asha.raman');
  const karthik = (a) => login(a, 'karthik.rao');
  const meena = (a) => login(a, 'meena.iyer');

  beforeEach(async (ctx) => {
    if (!mongo.available) return ctx.skip();
    await wipe();
    await runSeed(SEED);
  });

  it('nothing the API returns reveals seeded data (no seed/demo/sample wording, no markers, no demo domain)', async () => {
    const a = app();
    const A = { Authorization: `Bearer ${await asha(a)}` };
    const first = (await request(a).get('/api/broadcasts').set(A)).body.broadcasts[0];
    const bodies = [
      (await request(a).get('/api/broadcasts').set(A)).body,
      (await request(a).get(`/api/broadcasts/${first.id}`).set(A)).body,
      (await request(a).get('/api/emergency').set(A)).body,
      (await request(a).get('/api/analytics/global').set(A)).body,
      (await request(a).get(`/api/analytics/broadcasts/${first.id}`).set(A)).body,
      (await request(a).get('/api/admin/users').set(A)).body,
      (await request(a).get('/api/admin/overview').set(A)).body,
      (await request(a).get('/api/admin/audit').set(A)).body,
      (await request(a).get('/api/auth/me').set(A)).body,
    ];
    const text = JSON.stringify(bodies);
    expect(text.length).toBeGreaterThan(5000);
    expect(text).not.toMatch(/\b(demo|seed|seeded|sample|fake|fictional|dummy)\b|isSeed|seedBatchId|zerosignal\.demo/i);
  });

  it('sign-in works with the seeded credentials and rejects bad ones without saying which part was wrong', async () => {
    const a = app();
    const ok = await request(a).post('/api/auth/login').send({ email: `ASHA.RAMAN@${SEED.emailDomain}`, password: SEED.password });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ role: 'admin', name: 'Asha Raman' });
    expect(JSON.stringify(ok.body)).not.toMatch(/passwordHash|\$argon2|\$2[aby]\$/);
    const bad1 = await request(a).post('/api/auth/login').send({ email: `asha.raman@${SEED.emailDomain}`, password: 'wrong-password-1' });
    const bad2 = await request(a).post('/api/auth/login').send({ email: `nobody@${SEED.emailDomain}`, password: 'wrong-password-1' });
    expect(bad1.status).toBe(401);
    expect(bad2.body).toEqual(bad1.body);
  });

  it('broadcast lifecycle: create → start → analyse → send → supersede → analytics → stop → delete', async () => {
    const a = app();
    const H = { Authorization: `Bearer ${await karthik(a)}` };
    const created = await request(a).post('/api/broadcasts').set(H).send({ title: 'Coastal watch — Nagapattinam' });
    expect(created.status).toBe(201);
    const id = created.body.broadcast.id;
    expect((await request(a).post(`/api/broadcasts/${id}/start`).set(H)).body.broadcast.status).toBe('LIVE');
    expect((await request(a).post(`/api/broadcasts/${id}/start`).set(H)).status).toBe(409);

    const text = 'URGENT: Cyclone Varuna will make landfall near Nagapattinam tonight. Everyone within 5 km of the coast must evacuate now. Emergency help: 112.';
    const analysis = await request(a).post('/api/emergency/analyze').set(H).send({ text });
    expect(analysis.status).toBe(200);
    expect(analysis.body.meta.fallback).toBe(true);
    expect(analysis.body.analysis).toMatchObject({ priority: 'CRITICAL', category: 'CYCLONE' });

    const a1 = analysis.body.analysis;
    const sent = await request(a).post('/api/emergency').set(H).send({ broadcastId: id, original: text, priority: a1.priority, category: a1.category, summary: a1.summary, recommendedAction: a1.recommendedAction, analysisId: analysis.body.analysisId });
    expect(sent.status).toBe(201);
    expect(sent.body.message.aiMeta).toMatchObject({ source: 'fallback', fallback: true, editedByHuman: false });
    expect(dispatched.at(-1)).toMatchObject({ priority: 'CRITICAL', supersedes: [] });

    const edited = await request(a).post('/api/emergency').set(H).send({ broadcastId: id, original: text, priority: 'CRITICAL', category: 'CYCLONE', summary: 'Edited by a human', recommendedAction: a1.recommendedAction, analysisId: analysis.body.analysisId });
    expect(edited.body.message.aiMeta.editedByHuman).toBe(true);
    expect(edited.body.supersedes).toHaveLength(1);

    const preset = await request(a).post('/api/emergency').set(H).send({ broadcastId: id, original: text, priority: 'CRITICAL', category: 'CYCLONE', summary: 'Preset cyclone', recommendedAction: 'Evacuate', presetKey: 'cyclone-landfall' });
    expect(Object.keys(preset.body.message.signed).sort()).toEqual(['en', 'hi', 'ta', 'te']);
    expect(preset.body.message.translations.ta.source).toBe('preset');

    expect((await request(a).get('/api/emergency').set({ Authorization: `Bearer ${await meena(a)}` })).body.messages[0].original).toBeUndefined();

    const stats = await request(a).get('/api/analytics/global').set(H);
    expect(stats.status).toBe(200);
    expect(stats.body.totals.broadcasts).toBeGreaterThanOrEqual(6);
    expect(stats.body.delivery.critical.rate).toBe(100);

    expect((await request(a).post(`/api/broadcasts/${id}/stop`).set(H)).body.broadcast.status).toBe('ENDED');
    expect((await request(a).delete(`/api/broadcasts/${id}`).set(H)).status).toBe(200);
  });

  it('a broadcaster cannot modify another broadcaster’s broadcast; admins can', async () => {
    const a = app();
    const aT = { Authorization: `Bearer ${await asha(a)}` };
    const bT = { Authorization: `Bearer ${await karthik(a)}` };
    const mine = await request(a).post('/api/broadcasts').set(aT).send({ title: 'Owned by the admin' });
    const id = mine.body.broadcast.id;
    expect((await request(a).patch(`/api/broadcasts/${id}`).set(bT).send({ title: 'Hijacked' })).status).toBe(403);
    expect((await request(a).patch(`/api/broadcasts/${id}`).set(aT).send({ title: 'Renamed by owner' })).status).toBe(200);
  });

  it('admin health reports real services only (no seed indicator) and the streaming provider', async () => {
    const a = app();
    const h = await request(a).get('/api/admin/health').set({ Authorization: `Bearer ${await asha(a)}` });
    expect(h.status).toBe(200);
    expect(h.body.mongodb.status).toBe('up');
    expect(h.body.groq).toMatchObject({ configured: false, status: 'fallback' });
    expect(h.body.api.status).toBe('up');
    expect(h.body.streaming).toBeTruthy();
    expect(JSON.stringify(h.body)).not.toMatch(/seed|demo/i);
    expect(mongoose.connection.readyState).toBe(1);
  });

  it('the unique email index rejects duplicates regardless of case', async () => {
    await expect(User.create({ name: 'Dup', email: `ASHA.RAMAN@${SEED.emailDomain}`, passwordHash: 'x', role: 'receiver' })).rejects.toThrow(/duplicate|E11000/i);
  });
});
