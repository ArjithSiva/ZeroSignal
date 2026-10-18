import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { LANGUAGE_CODES, SCENARIOS, canonicalize } from '@zerosignal/shared';
import { loadConfig } from '../src/config/env.js';
import { sanitizeText, stripMongoOperators } from '../src/utils/sanitize.js';
import { createSigner } from '../src/services/signing.js';

describe('environment config', () => {
  it('development works with no env at all, with warnings', () => {
    const c = loadConfig({});
    expect(c.isProd).toBe(false);
    expect(c.warnings.length).toBeGreaterThan(0);
    expect(c.clientOrigins).toContain('http://localhost:5173');
  });

  it('production refuses to start without required secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/MONGODB_URI.*JWT_SECRET.*ALERT_SIGNING_SEED.*CLIENT_ORIGINS/);
  });

  it('production rejects a weak JWT secret and a malformed signing seed', () => {
    const base = { NODE_ENV: 'production', MONGODB_URI: 'mongodb://x/y', CLIENT_ORIGINS: 'https://app.example', ALERT_SIGNING_SEED: 'a'.repeat(64) };
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...base, JWT_SECRET: 'x'.repeat(40), ALERT_SIGNING_SEED: 'nothex' })).toThrow(/64 hex/);
    expect(loadConfig({ ...base, JWT_SECRET: 'x'.repeat(40) }).isProd).toBe(true);
  });

  it('parses origins, numbers and booleans', () => {
    const c = loadConfig({ CLIENT_ORIGINS: ' https://a.app/ , https://b.app ', PORT: '8080', RATE_LIMIT_AI_MAX: '3', ALLOW_PRODUCTION_SEED: 'true', COOKIE_SECURE: 'yes', GROQ_API_KEY: 'k' });
    expect(c.clientOrigins).toEqual(['https://a.app', 'https://b.app']);
    expect(c.port).toBe(8080);
    expect(c.rateLimit.aiMax).toBe(3);
    expect(c.auth.cookieSecure).toBe(true);
    expect('allowProductionSeed' in c).toBe(false); // the browser-seeding switch no longer exists
    expect(c.warnings.some((w) => /GROQ/.test(w))).toBe(false);
  });

  it('falls back to defaults on garbage numbers', () => {
    expect(loadConfig({ PORT: 'abc' }).port).toBe(5000);
  });
});

describe('NoSQL-injection protection', () => {
  it('strips $-operators and dotted keys at any depth', () => {
    const out = stripMongoOperators({ email: { $gt: '' }, nested: { $where: '1', ok: 1, 'a.b': 2 }, list: [{ $ne: 1, keep: true }] });
    expect(out).toEqual({ email: {}, nested: { ok: 1 }, list: [{ keep: true }] });
  });

  it('removes prototype-pollution keys', () => {
    const out = stripMongoOperators(JSON.parse('{"__proto__":{"admin":true},"constructor":{"x":1},"safe":1}'));
    expect(out).toEqual({ safe: 1 });
    expect({}.admin).toBeUndefined();
  });

  it('keeps primitives, arrays and dates intact', () => {
    const d = new Date();
    expect(stripMongoOperators({ a: 1, b: 'x', c: [1, 2], d, e: null })).toEqual({ a: 1, b: 'x', c: [1, 2], d, e: null });
  });

  it('bounds recursion depth', () => {
    let deep = {};
    const root = deep;
    for (let i = 0; i < 50; i++) deep = deep.n = {};
    expect(() => stripMongoOperators(root)).not.toThrow();
  });
});

describe('sanitizeText (untrusted AI/user text)', () => {
  it('removes tags, control characters and bidi overrides', () => {
    expect(sanitizeText('<script>x</script>Hello\u0000 ‮world<b>!</b>')).toBe('xHello world!');
  });
  it('collapses whitespace and limits length', () => {
    expect(sanitizeText('a   b\n\n\n\nc')).toBe('a b\n\nc');
    expect(sanitizeText('x'.repeat(50), 10)).toHaveLength(10);
  });
  it('returns an empty string for non-strings', () => {
    for (const v of [null, undefined, 5, {}, []]) expect(sanitizeText(v)).toBe('');
  });
  it('preserves Indic scripts', () => {
    expect(sanitizeText('வருணா புயல் 140')).toBe('வருணா புயல் 140');
  });
});

describe('alert signing (Ed25519)', () => {
  const signer = createSigner('11'.repeat(32));
  const cyclone = SCENARIOS.cyclone.messages.find((m) => m.priority === 'CRITICAL');
  const message = { id: 'm1', priority: 'CRITICAL', category: 'CYCLONE', issuedAtSec: 1_800_000_000, i18n: cyclone.i18n, zone: cyclone.zone };

  it('signs and verifies a payload', () => {
    const p = { v: 1, id: 'x', h: 'Evacuate' };
    expect(signer.verify(p, signer.sign(p))).toBe(true);
  });

  it('is independent of key order', () => {
    expect(signer.verify({ b: 2, a: 1 }, signer.sign({ a: 1, b: 2 }))).toBe(true);
  });

  it('detects tampering with any field', () => {
    const p = { v: 1, id: 'x', h: 'Evacuate', a: 'Go to shelter' };
    const sig = signer.sign(p);
    expect(signer.verify({ ...p, h: 'Stay home' }, sig)).toBe(false);
    expect(signer.verify({ ...p, extra: 1 }, sig)).toBe(false);
  });

  it('rejects signatures from a different key and malformed signatures', () => {
    const other = createSigner('22'.repeat(32));
    const p = { id: 'x' };
    expect(signer.verify(p, other.sign(p))).toBe(false);
    for (const bad of ['', 'not base64!!', null, undefined, 'AAAA']) expect(signer.verify(p, bad)).toBe(false);
  });

  it('signing is deterministic for a given key (Ed25519)', () => {
    expect(signer.sign({ a: 1 })).toBe(signer.sign({ a: 1 }));
  });

  it('signs a compact alert for every language, each under 1 KB', () => {
    const signed = signer.signMessage(message);
    expect(Object.keys(signed).sort()).toEqual([...LANGUAGE_CODES].sort());
    for (const lang of LANGUAGE_CODES) {
      expect(signed[lang].bytes).toBeLessThanOrEqual(1024);
      expect(signer.verify(signed[lang].payload, signed[lang].signature)).toBe(true);
    }
  });

  it('a tampered cached alert fails verification', () => {
    const { en } = signer.signMessage(message);
    const forged = { ...en.payload, h: 'ALL CLEAR — return home' };
    expect(signer.verify(forged, en.signature)).toBe(false);
  });

  it("the published public key verifies signatures independently (what a browser's WebCrypto does)", () => {
    const { en } = signer.signMessage(message);
    const raw = Buffer.from(signer.publicKeyB64, 'base64');
    expect(raw).toHaveLength(32);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(crypto.verify(null, Buffer.from(canonicalize(en.payload)), key, Buffer.from(en.signature, 'base64'))).toBe(true);
  });

  it('never exposes the private seed through the public API surface', () => {
    expect(JSON.stringify(Object.keys(signer))).not.toMatch(/seed|private/i);
    expect(signer.publicKeyB64).not.toContain('1111');
  });
});
