import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { createLimiters } from '../src/middleware/rateLimit.js';
import { createMailer } from '../src/services/auth/mailer.js';
import { createAccountService } from '../src/services/auth/accounts.js';
import { createHasher } from '../src/services/auth/passwords.js';
import { signToken } from '../src/middleware/auth.js';
import { getSigner } from '../src/services/signing.js';
import { unauthorized } from '../src/utils/errors.js';
import { createMemoryRepos } from './helpers/memoryRepos.js';

const config = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), CLIENT_ORIGINS: 'https://app.example.org', MAIL_TRANSPORT: 'memory', ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '1', COOKIE_SAMESITE: 'lax' });
const realtime = { broadcastStatus() {}, getReceivers: () => [], dispatchMessage: async () => ({}), stats: () => ({}) };
const ai = { enabled: false, analyze: async () => ({}), summarize: async () => ({}), translate: async () => ({}) };

function app(accounts) {
  const { repos } = createMemoryRepos();
  const mailer = createMailer(config.mail);
  const svc = accounts ?? createAccountService({ repos, config, mailer, hasher: createHasher(config.auth.argon2) });
  return createApp({ config, ai, signer: getSigner(), realtime, limiters: createLimiters({ windowMs: 60000, max: 1000, authMax: 1000, aiMax: 1000 }), repos, mailer, accounts: svc });
}
const bearer = (role) => ({ Authorization: `Bearer ${signToken({ _id: 'u1', role, name: 'T', email: 't@example.org' }, config)}` });

describe('refresh cookie survives a database hiccup', () => {
  it('does NOT clear the cookie on a 503 (cold start), but does on a real 401', async () => {
    const down = { refresh: async () => { throw Object.assign(new Error('db'), { name: 'MongoServerSelectionError' }); } };
    const r503 = await request(app(down)).post('/api/auth/refresh').set('X-ZS-CSRF', '1').set('Cookie', 'zs_rt=abc');
    expect(r503.status).toBe(503);
    expect((r503.headers['set-cookie'] ?? []).join(';')).not.toMatch(/zs_rt=;/);

    const expired = { refresh: async () => { throw unauthorized('Session expired'); } };
    const r401 = await request(app(expired)).post('/api/auth/refresh').set('X-ZS-CSRF', '1').set('Cookie', 'zs_rt=abc');
    expect(r401.status).toBe(401);
    expect((r401.headers['set-cookie'] ?? []).join(';')).toMatch(/zs_rt=;/);
  });
});

describe('network metrics are staff-only', () => {
  it('forbids receivers from reading or writing other people\'s link metrics', async () => {
    const a = app();
    const id = '64b7f0f0f0f0f0f0f0f0f0f0';
    expect((await request(a).get(`/api/network/metrics?broadcastId=${id}`).set(bearer('receiver'))).status).toBe(403);
    expect((await request(a).post('/api/network/metrics').set(bearer('receiver')).send({ broadcastId: id, samples: [{ receiverId: 'x', bandwidthKbps: 1 }] })).status).toBe(403);
  });
  it('still lets the unauthenticated probe endpoints work (Live Mode)', async () => {
    expect((await request(app()).get('/api/network/probe')).status).toBe(200);
  });
});
