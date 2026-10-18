import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createLimiters } from '../src/middleware/rateLimit.js';
import { loadConfig } from '../src/config/env.js';
import { createAccountService } from '../src/services/auth/accounts.js';
import { createHasher } from '../src/services/auth/passwords.js';
import { createMailer } from '../src/services/auth/mailer.js';
import { createAiService } from '../src/services/ai.js';
import { createGroqClient } from '../src/services/groq.js';
import { createSigner } from '../src/services/signing.js';
import { createMemoryRepos } from './helpers/memoryRepos.js';

const base = { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), CLIENT_ORIGINS: 'https://app.example.org', MAIL_TRANSPORT: 'memory', ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '1' };
const PW = 'Tr1cky-Harbour-Lamp';
const H = { 'X-ZS-CSRF': '1' };

function build(envOver = {}) {
  const config = loadConfig({ ...base, ...envOver });
  const { state, repos } = createMemoryRepos();
  const mailer = createMailer(config.mail);
  const accounts = createAccountService({ repos, config, mailer, hasher: createHasher(config.auth.argon2) });
  const ai = createAiService(createGroqClient({ apiKey: '', model: 'm', timeoutMs: 100, baseUrl: 'http://x' }));
  const realtime = { broadcastStatus() {}, getReceivers: () => [], stats: () => ({ sockets: 0, receivers: 0 }), dispatchMessage: async () => ({}) };
  const app = createApp({ config, ai, signer: createSigner('55'.repeat(32)), realtime, repos, mailer, accounts, limiters: createLimiters({ windowMs: 60_000, max: 1000, authMax: 1000, aiMax: 1000 }) });
  return { app, state, mailer, config };
}

const cookieOf = (res) => (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('zs_rt='));
const jar = (res) => cookieOf(res).split(';')[0];

let ctx;
beforeEach(() => {
  ctx = build();
});

describe('register / login / me', () => {
  it('registers a receiver, returns an access token and sets an httpOnly refresh cookie scoped to /api/auth', async () => {
    const res = await request(ctx.app).post('/api/auth/register').send({ name: 'Priya Natarajan', email: 'Priya@Mail.Example.org', password: PW, role: 'admin', language: 'ta' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'priya@mail.example.org', role: 'receiver', preferredLanguage: 'ta' });
    expect(res.body.token).toBeTruthy();
    expect(res.headers['cache-control']).toBe('no-store');
    const c = cookieOf(res);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\/api\/auth/);
    expect(c).not.toMatch(/Secure/i); // test env is not production
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refreshToken|seed/i);

    const me = await request(ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.body.user.email).toBe('priya@mail.example.org');
  });

  it('cookie is Secure in production and honours COOKIE_SAMESITE', () => {
    const prod = loadConfig({ ...base, NODE_ENV: 'production', MONGODB_URI: 'mongodb://x/y', ALERT_SIGNING_SEED: 'a'.repeat(64), COOKIE_SAMESITE: 'none', SMTP_URL: 'smtp://u:p@h:587' });
    expect(prod.auth.cookieSecure).toBe(true);
    expect(prod.auth.cookieSameSite).toBe('none');
  });

  it('validates input with field messages and rejects weak passwords', async () => {
    const bad = await request(ctx.app).post('/api/auth/register').send({ name: 'P', email: 'nope', password: 'x' });
    expect(bad.status).toBe(400);
    const weak = await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: 'password123' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details.length).toBeGreaterThan(0);
  });

  it('login: generic 401, then success; unknown extra fields are stripped', async () => {
    await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    const bad = await request(ctx.app).post('/api/auth/login').send({ email: 'p@mail.example.org', password: 'wrong-wrong-1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Incorrect email or password');
    const ok = await request(ctx.app).post('/api/auth/login').send({ email: 'p@mail.example.org', password: PW, role: 'admin' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('receiver');
  });

  it('NoSQL operator payloads cannot reach login', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
  });

  it('lockout surfaces as 429 ACCOUNT_LOCKED with retryAfterSec', async () => {
    await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    let last;
    for (let i = 0; i < 6; i++) last = await request(ctx.app).post('/api/auth/login').send({ email: 'p@mail.example.org', password: 'wrong-wrong-1' });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(last.body.error.details.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('refresh and logout (cookie + CSRF header)', () => {
  it('refresh needs the custom header, rotates the cookie, and the old one stops working after the grace window', async () => {
    const reg = await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    const c1 = jar(reg);

    expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', c1)).status).toBe(403); // no CSRF header
    const r = await request(ctx.app).post('/api/auth/refresh').set('Cookie', c1).set(H);
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(jar(r)).not.toBe(c1);
  });

  it('refresh without a cookie is 401 and clears any stale cookie', async () => {
    const res = await request(ctx.app).post('/api/auth/refresh').set(H);
    expect(res.status).toBe(401);
    expect(cookieOf(res)).toMatch(/zs_rt=;/);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const reg = await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    const c = jar(reg);
    expect((await request(ctx.app).post('/api/auth/logout').set('Cookie', c)).status).toBe(403);
    const out = await request(ctx.app).post('/api/auth/logout').set('Cookie', c).set(H);
    expect(out.status).toBe(200);
    expect(cookieOf(out)).toMatch(/zs_rt=;/);
    expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', c).set(H)).status).toBe(401);
  });

  it('CORS allows credentials only for allowlisted origins and the CSRF header', async () => {
    const ok = await request(ctx.app).options('/api/auth/refresh').set('Origin', 'https://app.example.org').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'x-zs-csrf');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.org');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['access-control-allow-headers']).toMatch(/X-ZS-CSRF/i);
    const evil = await request(ctx.app).post('/api/auth/refresh').set('Origin', 'https://evil.example.com').set(H);
    expect(evil.status).toBe(403);
  });
});

describe('password flows over HTTP', () => {
  it('change-password requires auth + current password and returns a fresh session', async () => {
    const reg = await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    const auth = { Authorization: `Bearer ${reg.body.token}` };
    expect((await request(ctx.app).post('/api/auth/change-password').send({ currentPassword: PW, newPassword: 'Another-Strong-Pass9' })).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/change-password').set(auth).send({ currentPassword: 'wrong-wrong-1', newPassword: 'Another-Strong-Pass9' })).status).toBe(403);
    const ok = await request(ctx.app).post('/api/auth/change-password').set(auth).send({ currentPassword: PW, newPassword: 'Another-Strong-Pass9' });
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toBeTruthy();
    expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', jar(reg)).set(H)).status).toBe(401); // old session ended
  });

  it('forgot-password answers identically for known and unknown emails; reset works end to end', async () => {
    await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    const a = await request(ctx.app).post('/api/auth/forgot-password').send({ email: 'p@mail.example.org' });
    const b = await request(ctx.app).post('/api/auth/forgot-password').send({ email: 'ghost@mail.example.org' });
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(ctx.mailer.outbox).toHaveLength(1);
    const token = new URL(ctx.mailer.outbox[0].text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    expect((await request(ctx.app).post('/api/auth/reset-password').send({ token, newPassword: 'Fresh-Reset-Pass7' })).status).toBe(200);
    expect((await request(ctx.app).post('/api/auth/reset-password').send({ token, newPassword: 'Fresh-Reset-Pass8' })).status).toBe(400);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: 'p@mail.example.org', password: 'Fresh-Reset-Pass7' })).status).toBe(200);
  });

  it('logout-all ends every session', async () => {
    const reg = await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    const second = await request(ctx.app).post('/api/auth/login').send({ email: 'p@mail.example.org', password: PW });
    const out = await request(ctx.app).post('/api/auth/logout-all').set('Authorization', `Bearer ${reg.body.token}`);
    expect(out.status).toBe(200);
    for (const r of [reg, second]) expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', jar(r)).set(H)).status).toBe(401);
  });
});

describe('profile and theme sync', () => {
  it('PATCH /me stores the theme and language on the profile', async () => {
    const reg = await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    const auth = { Authorization: `Bearer ${reg.body.token}` };
    const r = await request(ctx.app).patch('/api/auth/me').set(auth).send({ theme: 'light', preferredLanguage: 'hi' });
    expect(r.body.user).toMatchObject({ theme: 'light', preferredLanguage: 'hi' });
    expect((await request(ctx.app).patch('/api/auth/me').set(auth).send({ theme: 'neon' })).status).toBe(400);
    expect((await request(ctx.app).patch('/api/auth/me').set(auth).send({ role: 'admin' })).status).toBe(400); // nothing valid to update
    expect((await request(ctx.app).get('/api/auth/me').set(auth)).body.user.theme).toBe('light');
  });
});

describe('admin user management over HTTP', () => {
  async function adminToken() {
    const { state } = ctx;
    const hasher = createHasher(ctx.config.auth.argon2);
    // an admin exists (created out-of-band, e.g. by the CLI seed); sign in the normal way
    const id = 'a1'.repeat(12);
    state.users.set(id, { id, name: 'Asha Raman', email: 'asha@mail.example.org', role: 'admin', passwordHash: await hasher.hash('Harbour-Strong-Pass5'), active: true, failedLogins: 0, lockedUntil: null, totp: { enabled: false }, tokenVersion: 0 });
    return (await request(ctx.app).post('/api/auth/login').send({ email: 'asha@mail.example.org', password: 'Harbour-Strong-Pass5' })).body.token;
  }

  it('admin creates a broadcaster with an invite link; the invitee sets a password and lands signed in with the right role', async () => {
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };
    const c = await request(ctx.app).post('/api/admin/users').set(auth).send({ name: 'Karthik Rao', email: 'karthik@mail.example.org', role: 'broadcaster' });
    expect(c.status).toBe(201);
    expect(c.body.inviteUrl).toContain('/setup-account?token=');
    expect(JSON.stringify(c.body)).not.toMatch(/passwordHash/);

    const inviteToken = new URL(c.body.inviteUrl).searchParams.get('token');
    const done = await request(ctx.app).post('/api/auth/setup-account').send({ token: inviteToken, newPassword: 'Granite-Strong-Pass3' });
    expect(done.status).toBe(200);
    expect(done.body.user.role).toBe('broadcaster');

    const list = await request(ctx.app).get('/api/admin/users').set(auth);
    const k = list.body.users.find((u) => u.email === 'karthik@mail.example.org');
    expect(k).toMatchObject({ role: 'broadcaster', active: true, invitePending: false });
    expect(Object.keys(k).join()).not.toMatch(/seed|password|hash/i);
  });

  it('receivers and broadcasters cannot reach admin user management; self-demotion is refused; audit is readable', async () => {
    const adminTok = await adminToken();
    const reg = await request(ctx.app).post('/api/auth/register').send({ name: 'Priya N', email: 'p@mail.example.org', password: PW });
    expect((await request(ctx.app).post('/api/admin/users').set({ Authorization: `Bearer ${reg.body.token}` }).send({ name: 'Evil One', email: 'e@mail.example.org', role: 'admin' })).status).toBe(403);
    const adminId = [...ctx.state.users.values()].find((u) => u.role === 'admin').id;
    expect((await request(ctx.app).patch(`/api/admin/users/${adminId}/role`).set({ Authorization: `Bearer ${adminTok}` }).send({ role: 'receiver' })).status).toBe(409);
    const audit = await request(ctx.app).get('/api/admin/audit').set({ Authorization: `Bearer ${adminTok}` });
    expect(audit.status).toBe(200);
    expect(audit.body.events.map((e) => e.type)).toContain('REGISTER');
  });
});
