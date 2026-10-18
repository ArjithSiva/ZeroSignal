import { describe, expect, it } from 'vitest';
import { buildSeedDataset, SEED_BATCH_ID, SEED_PEOPLE, scrub, seedId } from '../src/seed/dataset.js';
import { createSigner } from '../src/services/signing.js';
import { computeAnalytics } from '../src/services/analytics.js';
import { CATEGORIES, PRIORITIES } from '@zerosignal/shared';

const signer = createSigner('44'.repeat(32));
const NOW = Date.parse('2026-10-13T06:00:00Z');
const DOMAIN = 'responders.example.org';
const build = (now = NOW) => buildSeedDataset({ now, passwordHash: 'x', emailDomain: DOMAIN, signer });
const data = build();

describe('seed dataset (spec §7)', () => {
  it('has staff and receiver accounts with realistic names on the configured domain', () => {
    expect(new Set(data.users.map((u) => u.role))).toEqual(new Set(['admin', 'broadcaster', 'receiver']));
    expect(data.users).toHaveLength(SEED_PEOPLE.length);
    for (const u of data.users) {
      expect(u.email.endsWith(`@${DOMAIN}`)).toBe(true);
      expect(u.name).toMatch(/^[A-Z][a-z]+( [A-Z][a-z]+)+$/); // a person's name, no role suffix
    }
  });

  it('takes the email domain from configuration and refuses to guess one', () => {
    expect(buildSeedDataset({ now: NOW, passwordHash: 'x', emailDomain: 'mail.other.in', signer }).users.every((u) => u.email.endsWith('@mail.other.in'))).toBe(true);
    expect(() => buildSeedDataset({ now: NOW, passwordHash: 'x', signer })).toThrow(/emailDomain/);
  });

  it('has 5+ broadcasts, 10+ messages across every priority and category, hundreds of samples', () => {
    expect(data.broadcasts.length).toBeGreaterThanOrEqual(5);
    expect(data.messages.length).toBeGreaterThanOrEqual(10);
    expect(new Set(data.messages.map((m) => m.priority))).toEqual(new Set(PRIORITIES));
    expect(new Set(data.messages.map((m) => m.category))).toEqual(new Set(CATEGORIES));
    expect(data.metrics.length).toBeGreaterThanOrEqual(300);
    expect(data.sessions.length).toBeGreaterThanOrEqual(10);
  });

  it('is deterministic: same anchor time → identical dataset (idempotent seeding)', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
    expect(JSON.stringify(build(NOW + 1000))).not.toBe(JSON.stringify(data));
  });

  it('uses unique, stable ids (no duplicates on re-seed)', () => {
    for (const key of ['broadcasts', 'messages', 'sessions', 'users']) {
      const ids = data[key].map((d) => d._id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-f0-9]{24}$/);
    }
    expect(seedId('x')).toBe(seedId('x'));
  });

  it('every reference points at something that exists', () => {
    const b = new Set(data.broadcasts.map((x) => x._id));
    const m = new Set(data.messages.map((x) => x._id));
    for (const x of [...data.messages, ...data.metrics, ...data.events, ...data.sessions, ...data.deliveries, ...data.acks]) expect(b.has(x.broadcastId)).toBe(true);
    for (const x of [...data.deliveries, ...data.acks]) expect(m.has(x.messageId)).toBe(true);
    for (const x of data.messages.filter((x) => x.supersededBy)) expect(m.has(x.supersededBy)).toBe(true);
  });

  it('every record carries the internal seedBatchId so seed:clean removes exactly the seeded data', () => {
    for (const [k, rows] of Object.entries(data)) for (const r of rows) expect(r.seedBatchId, k).toBe(SEED_BATCH_ID);
    expect(JSON.stringify(data)).not.toContain('isSeed');
  });

  it('nothing user-visible reads as sample data (no demo / seed / sample / test / fake wording anywhere)', () => {
    const BANNED = /\b(demo|seed|seeded|sample|test|testing|fake|fictional|dummy|mock)\b/i;
    const walk = (v, path, out) => {
      if (typeof v === 'string') {
        if (BANNED.test(v)) out.push(`${path}: ${v.slice(0, 80)}`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
      else if (v && typeof v === 'object' && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) if (k !== 'seedBatchId') walk(x, `${path}.${k}`, out);
      return out;
    };
    expect(walk(data, 'data', [])).toEqual([]);
  });

  it('scrub() removes demo labels from scenario text without touching anything else', () => {
    expect(scrub('Cyclone Varuna (demo) will land')).toBe('Cyclone Varuna will land');
    expect(scrub({ label: 'Nagapattinam coast (demo zone)', n: 5 })).toEqual({ label: 'Nagapattinam coast', n: 5 });
    expect(scrub('Plain text')).toBe('Plain text');
  });

  it('signed payloads still verify after scrubbing (signing happens on the clean text)', () => {
    for (const m of data.messages) for (const s of Object.values(m.signed)) expect(signer.verify(s.payload, s.signature)).toBe(true);
  });

  it('contains the full engine-produced ladder 720p→480p→240p→AUDIO→TEXT', () => {
    const keys = new Set(data.events.map((e) => `${e.from}→${e.to}`));
    for (const k of ['720p→480p', '480p→240p', '240p→AUDIO', 'AUDIO→TEXT']) expect(keys.has(k), k).toBe(true);
    expect(keys.has('TEXT→CACHED') || keys.has('AUDIO→CACHED')).toBe(true);
    for (const e of data.events) expect(e.reason.length).toBeGreaterThan(10);
  });

  it('includes both reactive and predictive transitions', () => {
    const triggers = new Set(data.events.map((e) => e.trigger));
    expect(triggers.has('REACTIVE')).toBe(true);
    expect(triggers.has('PREDICTIVE')).toBe(true);
  });

  it('CRITICAL alerts are 100% delivered in the seeded history (the headline claim)', () => {
    const a = computeAnalytics(data);
    expect(a.delivery.critical.total).toBeGreaterThan(0);
    expect(a.delivery.critical.rate).toBe(100);
    expect(a.delivery.deliveryRate).toBeLessThan(100); // LOW alerts were deferred on poor links: honest, not 100%
  });

  it('offline receivers get the SIMULATED SMS channel, never a live TEXT delivery', () => {
    const sms = data.deliveries.filter((d) => d.channel === 'SMS_SIMULATED');
    for (const d of sms) expect(['CRITICAL', 'HIGH']).toContain(d.priority);
  });

  it('signs every message in every available language, each payload < 1 KB', () => {
    for (const m of data.messages) {
      expect(Object.keys(m.signed)).toContain('en');
      for (const s of Object.values(m.signed)) {
        expect(s.bytes).toBeLessThanOrEqual(1024);
        expect(signer.verify(s.payload, s.signature)).toBe(true);
      }
    }
    const cyclone = data.messages.find((m) => m.priority === 'CRITICAL' && m.category === 'CYCLONE');
    expect(Object.keys(cyclone.signed).sort()).toEqual(['en', 'hi', 'ta', 'te']);
  });

  it('seeded translations are honestly labelled preset / original, never claimed as live AI', () => {
    const cyclone = data.messages.find((m) => m.priority === 'CRITICAL' && m.category === 'CYCLONE');
    expect(cyclone.translations.ta.source).toBe('preset');
    expect(cyclone.translations.en.source).toBe('original');
    expect(cyclone.aiMeta.source).toBe('preset');
  });

  it('has realistic AI usage including failures', () => {
    expect(data.aiUsage.length).toBeGreaterThanOrEqual(30);
    expect(data.aiUsage.some((u) => !u.ok)).toBe(true);
    expect(data.aiUsage.filter((u) => !u.ok).every((u) => u.source === 'fallback' && u.error)).toBe(true);
  });

  it('metrics carry the engine’s tier and a health score', () => {
    for (const m of data.metrics) {
      expect(['720p', '480p', '240p', 'AUDIO', 'TEXT', 'CACHED']).toContain(m.tier);
      expect(m.healthScore).toBeGreaterThanOrEqual(0);
      expect(m.healthScore).toBeLessThanOrEqual(100);
    }
  });

  it('analytics over the seed produce the numbers the demo narrative quotes', () => {
    const a = computeAnalytics(data);
    expect(a.totals.receivers).toBe(4);
    expect(a.adaptation.total).toBeGreaterThan(5);
    expect(a.quality.distribution.find((d) => d.tier === 'TEXT').samples).toBeGreaterThan(0);
  });
});
