import { describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createLimiters } from '../src/middleware/rateLimit.js';
import { loadConfig } from '../src/config/env.js';
import { signToken } from '../src/middleware/auth.js';
import { createAiService } from '../src/services/ai.js';
import { createGroqClient } from '../src/services/groq.js';
import { createSigner } from '../src/services/signing.js';
import { createMediaService } from '../src/services/media/index.js';
import { createHlsProvider, ffmpegArgs } from '../src/services/media/hls.js';
import { createLivekitProvider } from '../src/services/media/livekit.js';
import { roomFor, signHls, verifyHls } from '../src/services/media/rooms.js';
import { createSimulatedProvider } from '../src/services/media/simulated.js';
import { createMemoryRepos } from './helpers/memoryRepos.js';

const LK = { LIVEKIT_URL: 'wss://lk.example.test', LIVEKIT_API_KEY: 'APIkey123', LIVEKIT_API_SECRET: 'lk-secret-lk-secret-lk-secret-0123456789' };
const base = { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), CLIENT_ORIGINS: 'https://app.example.org', MAIL_TRANSPORT: 'memory', ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '1' };
const BID = '64b7f0c2a1b2c3d4e5f60718';

const user = (id, role) => ({ _id: id, id, name: `User ${id}`, email: `${id}@x.org`, role });

function build(env = {}, { providers } = {}) {
  const config = loadConfig({ ...base, ...env });
  const media = createMediaService({ config, providers });
  const boards = { [BID]: { id: BID, status: 'LIVE', createdBy: 'owner' } };
  const { repos } = createMemoryRepos();
  const realtime = { broadcastStatus() {}, getReceivers: () => [], stats: () => ({ sockets: 0, receivers: 0 }), dispatchMessage: async () => ({}) };
  const app = createApp({ config, ai: createAiService(createGroqClient({ apiKey: '', model: 'm', timeoutMs: 100, baseUrl: 'http://x' })), signer: createSigner('55'.repeat(32)), realtime, repos, media, limiters: createLimiters({ windowMs: 60_000, max: 1000, authMax: 1000, aiMax: 1000 }) });
  const tok = (id, role) => `Bearer ${signToken(user(id, role), config)}`;
  return { app, media, config, tok, boards };
}

describe('room names', () => {
  it('are deterministic, unguessable and never contain the broadcast id', () => {
    const a = roomFor('salt', BID);
    expect(a).toBe(roomFor('salt', BID));
    expect(a).not.toBe(roomFor('other-salt', BID));
    expect(a).toMatch(/^zs-[0-9a-f]{24}$/);
    expect(a).not.toContain(BID);
  });
  it('signed HLS prefixes verify only for the right room, unexpired and untampered', () => {
    const now = 1_800_000_000;
    const p = signHls('s', 'zs-aaaaaaaaaaaaaaaaaaaaaaaa', now + 60);
    expect(verifyHls('s', 'zs-aaaaaaaaaaaaaaaaaaaaaaaa', p, now)).toBe(true);
    expect(verifyHls('s', 'zs-bbbbbbbbbbbbbbbbbbbbbbbb', p, now)).toBe(false);
    expect(verifyHls('other', 'zs-aaaaaaaaaaaaaaaaaaaaaaaa', p, now)).toBe(false);
    expect(verifyHls('s', 'zs-aaaaaaaaaaaaaaaaaaaaaaaa', p, now + 61)).toBe(false);
    expect(verifyHls('s', 'zs-aaaaaaaaaaaaaaaaaaaaaaaa', 'junk', now)).toBe(false);
    expect(verifyHls('s', 'zs-aaaaaaaaaaaaaaaaaaaaaaaa', `${now + 60}.${'A'.repeat(32)}`, now)).toBe(false);
  });
});

describe('LiveKit token issuing (real livekit-server-sdk, no network)', () => {
  const cfg = loadConfig({ ...base, ...LK }).media.livekit;
  const p = createLivekitProvider(cfg);
  const decode = (t) => jwt.decode(t);

  it('is unavailable without credentials', () => {
    expect(createLivekitProvider(loadConfig(base).media.livekit).available).toBe(false);
    expect(p.available).toBe(true);
  });
  it('publisher tokens can publish but not subscribe', async () => {
    const { token, url } = await p.publishCredentials({ room: 'zs-room', identity: 'pub-1', name: 'B' });
    const c = decode(token);
    expect(url).toBe(LK.LIVEKIT_URL);
    expect(c.video).toMatchObject({ room: 'zs-room', roomJoin: true, canPublish: true, canSubscribe: false, canPublishData: false });
    expect(c.iss).toBe(LK.LIVEKIT_API_KEY);
    expect(c.sub).toBe('pub-1');
    expect(c.exp - c.nbf).toBeLessThanOrEqual(3600 + 5);
  });
  it('viewer tokens can subscribe but never publish', async () => {
    const c = decode((await p.viewerCredentials({ room: 'zs-room', identity: 'view-1', name: 'R' })).token);
    expect(c.video).toMatchObject({ roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false });
  });
  it('never leaks the API secret in what it returns', async () => {
    const out = JSON.stringify(await p.viewerCredentials({ room: 'r', identity: 'i', name: 'n' })) + JSON.stringify(await p.publishCredentials({ room: 'r', identity: 'i', name: 'n' }));
    expect(out).not.toContain(LK.LIVEKIT_API_SECRET);
  });
  it('a token verifies with the secret and not with another', async () => {
    const { token } = await p.viewerCredentials({ room: 'r', identity: 'i', name: 'n' });
    expect(() => jwt.verify(token, LK.LIVEKIT_API_SECRET)).not.toThrow();
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });
});

describe('ffmpeg ladder arguments', () => {
  const args = (o) => ffmpegArgs({ outDir: '/o', ...o });
  it('builds a 720/480/240 + audio-only ladder', () => {
    const a = args({ kind: 'pattern' }).join(' ');
    expect(a).toContain('scale=-2:720');
    expect(a).toContain('scale=-2:480');
    expect(a).toContain('scale=-2:240');
    expect(a).toContain('name:720p v:1,a:1,name:480p v:2,a:2,name:240p a:3,name:AUDIO');
    expect(a).toContain('-master_pl_name master.m3u8');
  });
  it('loops a file source and reads a URL source once', () => {
    expect(args({ kind: 'file', source: '/v.mp4' }).join(' ')).toContain('-stream_loop -1 -i /v.mp4');
    expect(args({ kind: 'url', source: 'rtmp://h/live' }).join(' ')).toContain('-i rtmp://h/live');
  });
});

describe('HLS provider', () => {
  const fakeSpawn = () => { const handlers = {}; return { killed: false, stderr: { on() {} }, on: (e, f) => { handlers[e] = f; }, kill() { this.killed = true; handlers.exit?.(null); } }; };
  it('issues local links that expire, and CDN links when HLS_BASE_URL is set', async () => {
    const local = createHlsProvider({ baseUrl: '', outputDir: '/tmp/zs-t', ffmpegPath: 'ffmpeg' }, { salt: 's', now: () => 1_800_000_000_000, spawn: fakeSpawn });
    const l = await local.viewerCredentials({ room: 'zs-x', ttlSec: 60 });
    expect(l.local).toBe(true);
    expect(l.playlistUrl).toMatch(/^\/media\/hls\/1800000060\.[\w-]{32}\/zs-x\/master\.m3u8$/);
    const cdn = createHlsProvider({ baseUrl: 'https://cdn.example.org/live/', outputDir: '', ffmpegPath: 'ffmpeg' }, { salt: 's', spawn: fakeSpawn });
    expect((await cdn.viewerCredentials({ room: 'zs-x' })).playlistUrl).toBe('https://cdn.example.org/live/zs-x/master.m3u8');
  });
  it('reports a missing FFmpeg binary honestly', async () => {
    const { spawn } = await import('node:child_process');
    const p = createHlsProvider({ baseUrl: '', outputDir: '/tmp/zs-t2', ffmpegPath: '/nonexistent/ffmpeg' }, { salt: 's', spawn, log: { error() {} } });
    await p.start('zs-y', { kind: 'pattern' });
    await new Promise((r) => setTimeout(r, 200));
    expect(p.status('zs-y')).toMatchObject({ status: 'error', error: expect.stringContaining('not found') });
    await p.stopAll();
  });
});

describe('provider chain and degradation', () => {
  it('with nothing configured the chain is only simulated, and health says so', () => {
    const { media } = build({ MEDIA_PROVIDERS: 'livekit,simulated' });
    expect(media.chain).toEqual(['simulated']);
    expect(media.health()).toMatchObject({ status: 'degraded', provider: 'simulated' });
  });
  it('with LiveKit configured the order is livekit → hls → simulated, always ending in simulated', () => {
    const { media } = build(LK);
    expect(media.chain).toEqual(['livekit', 'hls', 'simulated']);
    expect(media.describe().providers.find((p) => p.id === 'simulated').simulated).toBe(true);
  });
  it('hls is only offered to viewers while a ladder is actually running', async () => {
    const hls = { ...createHlsProvider({ baseUrl: '', outputDir: '/tmp/zs-t3', ffmpegPath: 'ffmpeg' }, { salt: 's', spawn: () => { throw new Error('no'); } }), status: () => null };
    const { media } = build({}, { providers: { hls, simulated: createSimulatedProvider() } });
    const v = await media.view({ broadcast: { id: BID }, user: user('u1', 'receiver') });
    expect(v.chain.map((c) => c.provider)).toEqual(['simulated']);
  });
});

describe('media routes', () => {
  it('requires sign-in', async () => {
    const { app } = build(LK);
    expect((await request(app).get('/api/media/config')).status).toBe(401);
    expect((await request(app).post(`/api/media/${BID}/view-token`)).status).toBe(401);
  });
  it('/config lists providers and never includes secrets', async () => {
    const { app, tok } = build(LK);
    const res = await request(app).get('/api/media/config').set('Authorization', tok('u1', 'receiver'));
    expect(res.status).toBe(200);
    expect(res.body.chain).toEqual(['livekit', 'hls', 'simulated']);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|APIkey123|apiKey/i);
  });
  it('receivers cannot get publish tokens or start HLS', async () => {
    const { app, tok } = build(LK);
    expect((await request(app).post(`/api/media/${BID}/publish-token`).set('Authorization', tok('u1', 'receiver')).send({})).status).toBe(403);
    expect((await request(app).post(`/api/media/${BID}/hls/start`).set('Authorization', tok('u1', 'receiver')).send({})).status).toBe(403);
  });
  it('a malformed id is rejected before any lookup', async () => {
    const { app, tok } = build(LK);
    expect((await request(app).post('/api/media/not-an-id/view-token').set('Authorization', tok('u1', 'receiver'))).status).toBe(400);
  });
});

describe('media routes with a broadcast', () => {
  const mk = (env = LK) => {
    const ctx = build(env);
    // swap the loader through a fresh router instance is overkill: exercise the real routes with an injected loader
    return ctx;
  };
  it('owner vs other broadcaster vs admin on publish-token (injected loader)', async () => {
    const { mediaRoutes } = await import('../src/routes/media.js');
    const express = (await import('express')).default;
    const { errorHandler } = await import('../src/middleware/errors.js');
    const ctx = mk();
    const app = express();
    app.locals.config = ctx.config;
    app.use(express.json());
    app.use('/api/media', mediaRoutes({ media: ctx.media, loadBroadcast: async (id) => (id === BID ? { id: BID, status: 'LIVE', createdBy: 'owner' } : null) }));
    app.use(errorHandler);
    const post = (who, role, path, body = {}) => request(app).post(`/api/media/${BID}/${path}`).set('Authorization', ctx.tok(who, role)).send(body);

    const own = await post('owner', 'broadcaster', 'publish-token');
    expect(own.status).toBe(200);
    expect(jwt.decode(own.body.token).video).toMatchObject({ canPublish: true, canSubscribe: false });
    expect(own.body.room).toMatch(/^zs-/);
    expect((await post('someone-else', 'broadcaster', 'publish-token')).status).toBe(403);
    expect((await post('boss', 'admin', 'publish-token')).status).toBe(200);

    const view = await post('r1', 'receiver', 'view-token');
    expect(view.status).toBe(200);
    expect(view.body.room).toBe(own.body.room);
    expect(view.body.chain.map((c) => c.provider)).toEqual(['livekit', 'simulated']); // hls not running
    expect(jwt.decode(view.body.chain[0].token).video).toMatchObject({ canPublish: false, canSubscribe: true });
    expect(JSON.stringify(view.body)).not.toContain(LK.LIVEKIT_API_SECRET);

    expect((await request(app).post(`/api/media/${'a'.repeat(24)}/view-token`).set('Authorization', ctx.tok('r1', 'receiver'))).status).toBe(404);
  });
  it('rejects unsafe HLS sources', async () => {
    const { mediaRoutes } = await import('../src/routes/media.js');
    const express = (await import('express')).default;
    const { errorHandler } = await import('../src/middleware/errors.js');
    const ctx = mk();
    const app = express();
    app.locals.config = ctx.config;
    app.use(express.json());
    app.use('/api/media', mediaRoutes({ media: ctx.media, loadBroadcast: async () => ({ id: BID, status: 'LIVE', createdBy: 'owner' }) }));
    app.use(errorHandler);
    const start = (body) => request(app).post(`/api/media/${BID}/hls/start`).set('Authorization', ctx.tok('owner', 'broadcaster')).send(body);
    for (const source of ['file:///etc/passwd', '/etc/passwd', 'concat:a|b', 'http-not', '']) expect((await start({ kind: 'url', source })).status).toBe(400);
    expect((await start({ kind: 'file', source: '/etc/passwd' })).status).toBe(400);
  });
});

describe('local HLS delivery is gated by a signed, expiring link', () => {
  it('serves with a valid prefix and refuses missing/expired/forged ones', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-static-'));
    const room = roomFor('t'.repeat(40), BID);
    fs.mkdirSync(path.join(dir, room), { recursive: true });
    fs.writeFileSync(path.join(dir, room, 'master.m3u8'), '#EXTM3U\n');
    const config = loadConfig({ ...base, MEDIA_ROOM_SALT: 't'.repeat(40), HLS_OUTPUT_DIR: dir });
    const media = createMediaService({ config });
    const { app } = { app: createApp({ config, ai: createAiService(createGroqClient({ apiKey: '', model: 'm', timeoutMs: 100, baseUrl: 'http://x' })), signer: createSigner('55'.repeat(32)), realtime: { broadcastStatus() {}, getReceivers: () => [], stats: () => ({}) }, repos: createMemoryRepos().repos, media }) };
    const good = (await media.providers.hls.viewerCredentials({ room })).playlistUrl;
    expect((await request(app).get(good)).status).toBe(200);
    const forged = good.replace(/\/\d+\.[\w-]+\//, `/${Math.floor(Date.now() / 1000) + 99}.${'A'.repeat(32)}/`);
    expect((await request(app).get(forged)).status).toBe(403);
    const expired = `/media/hls/${signHls('t'.repeat(40), room, 1000)}/${room}/master.m3u8`;
    expect((await request(app).get(expired)).status).toBe(403);
    expect((await request(app).get(`/media/hls/x.y/${room}/master.m3u8`)).status).toBe(403);
    expect((await request(app).get(good.replace('master.m3u8', '../../etc/passwd'))).status).not.toBe(200);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
