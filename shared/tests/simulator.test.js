import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  SCENARIOS,
  SCENARIO_IDS,
  LANGUAGE_CODES,
  applyChaos,
  applyNoise,
  buildCompactAlert,
  byteLength,
  canonicalize,
  compactSize,
  createRng,
  dataSaved,
  decide,
  degradingCurve,
  metricsFromSlider,
  sampleCurve,
  sliderFromBandwidth,
  createEngineState,
  COMPACT_MAX_BYTES,
} from '../src/index.js';

describe('presets and slider', () => {
  it('presets drive the engine to the documented tiers', () => {
    const tier = (name) => decide(PRESETS[name]).decision.tier;
    expect(tier('EXCELLENT')).toBe('720p');
    expect(tier('GOOD')).toBe('480p');
    expect(tier('MODERATE')).toBe('240p');
    expect(tier('POOR')).toBe('AUDIO');
    expect(tier('CRITICAL')).toBe('TEXT');
    expect(tier('OFFLINE')).toBe('CACHED');
  });

  it('slider endpoints equal the CRITICAL and EXCELLENT presets', () => {
    expect(metricsFromSlider(0)).toMatchObject({ bandwidthKbps: 60, packetLoss: 14 });
    expect(metricsFromSlider(100)).toMatchObject({ bandwidthKbps: 12000, latencyMs: 25 });
  });

  it('slider is monotone: bandwidth rises and impairments fall as it moves up', () => {
    let prev = metricsFromSlider(0);
    for (let v = 1; v <= 100; v++) {
      const cur = metricsFromSlider(v);
      expect(cur.bandwidthKbps).toBeGreaterThanOrEqual(prev.bandwidthKbps);
      expect(cur.latencyMs).toBeLessThanOrEqual(prev.latencyMs);
      expect(cur.packetLoss).toBeLessThanOrEqual(prev.packetLoss + 0.01);
      prev = cur;
    }
  });

  it('slider clamps and tolerates garbage', () => {
    expect(metricsFromSlider(-50)).toEqual(metricsFromSlider(0));
    expect(metricsFromSlider(500)).toEqual(metricsFromSlider(100));
    expect(metricsFromSlider(NaN)).toEqual(metricsFromSlider(0));
  });

  it('sliderFromBandwidth inverts the mapping approximately', () => {
    for (const v of [10, 40, 60, 90]) {
      const bw = metricsFromSlider(v).bandwidthKbps;
      expect(Math.abs(sliderFromBandwidth(bw) - v)).toBeLessThanOrEqual(2);
    }
    expect(sliderFromBandwidth(0)).toBe(0);
  });
});

describe('noise and chaos', () => {
  it('same seed → same noise; different seed → different', () => {
    const a = applyNoise(PRESETS.GOOD, createRng(7));
    const b = applyNoise(PRESETS.GOOD, createRng(7));
    const c = applyNoise(PRESETS.GOOD, createRng(8));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('noise keeps values physical and leaves OFFLINE alone', () => {
    const rng = createRng(3);
    for (let i = 0; i < 500; i++) {
      const n = applyNoise(PRESETS.POOR, rng);
      expect(n.bandwidthKbps).toBeGreaterThan(0);
      expect(n.packetLoss).toBeGreaterThanOrEqual(0);
      expect(n.stability).toBeLessThanOrEqual(100);
    }
    expect(applyNoise(PRESETS.OFFLINE, rng)).toEqual(PRESETS.OFFLINE);
    expect(applyNoise(PRESETS.GOOD, rng, 0)).toEqual(PRESETS.GOOD);
  });

  it('noise on an EXCELLENT link does not wander off the 720p tier', () => {
    const rng = createRng(11);
    let state = createEngineState();
    const tiers = new Set();
    for (let i = 0; i < 200; i++) {
      const r = decide(applyNoise(PRESETS.EXCELLENT, rng), 'NORMAL', state);
      state = r.state;
      tiers.add(r.decision.tier);
    }
    expect([...tiers]).toEqual(['720p']);
  });

  it('chaos at intensity 0 changes nothing; at 1 it eventually hurts quality', () => {
    const rng = createRng(5);
    expect(applyChaos(PRESETS.EXCELLENT, rng, 0)).toEqual(PRESETS.EXCELLENT);
    let hurt = 0;
    for (let i = 0; i < 100; i++) {
      const c = applyChaos(PRESETS.EXCELLENT, rng, 1);
      if (c.bandwidthKbps < 8000 || c.packetLoss > 5 || c.latencyMs > 400) hurt++;
    }
    expect(hurt).toBeGreaterThan(20);
    expect(applyChaos(PRESETS.OFFLINE, rng, 1)).toEqual(PRESETS.OFFLINE);
  });
});

describe('scripted curves', () => {
  it('degradingCurve walks the whole ladder from 720p down to TEXT', () => {
    const curve = degradingCurve(120);
    let state = createEngineState();
    const path = [];
    for (let t = 0; t <= 120; t += 2) {
      const r = decide(sampleCurve(curve, t), 'NORMAL', state);
      state = r.state;
      if (r.decision.changed || r.decision.initial) path.push(r.decision.tier);
    }
    expect(path[0]).toBe('720p');
    expect(path.at(-1)).toBe('TEXT');
    expect(path).toEqual(expect.arrayContaining(['480p', '240p', 'AUDIO']));
  });

  it('sampleCurve interpolates and handles offline step keyframes', () => {
    const curve = [{ t: 0, slider: 100 }, { t: 10, slider: 0 }, { t: 20, offline: true }];
    expect(sampleCurve(curve, 0).bandwidthKbps).toBe(12000);
    const mid = sampleCurve(curve, 5).bandwidthKbps;
    expect(mid).toBeLessThan(12000);
    expect(mid).toBeGreaterThan(60);
    expect(sampleCurve(curve, 25).online).toBe(false);
    expect(sampleCurve(curve, -5).bandwidthKbps).toBe(12000);
    expect(sampleCurve([], 5).online).toBe(true);
  });

  it('the cyclone scenario gives each demo receiver a different story', () => {
    const { curves } = SCENARIOS.cyclone;
    const tierAt = (id, t) => decide(sampleCurve(curves[id], t)).decision.tier;
    expect(tierAt('A', 0)).toBe('720p');
    expect(['720p', '480p']).toContain(tierAt('A', 100));
    expect(tierAt('C', 100)).toBe('TEXT');
    expect(tierAt('C', 140)).toBe('CACHED');
  });
});

describe('scenario content', () => {
  it('has four scenarios, each with messages and per-receiver curves', () => {
    expect([...SCENARIO_IDS].sort()).toEqual(['cyclone', 'earthquake', 'flood', 'tower']);
    for (const id of SCENARIO_IDS) {
      const s = SCENARIOS[id];
      expect(s.messages.length).toBeGreaterThan(0);
      expect(Object.keys(s.curves).sort()).toEqual(['A', 'B', 'C', 'D']);
    }
  });

  it('every scenario message is translated into all four launch languages', () => {
    for (const id of SCENARIO_IDS) {
      for (const m of SCENARIOS[id].messages) {
        for (const lang of LANGUAGE_CODES) {
          const l = m.i18n[lang];
          expect(l?.text?.length, `${m.key}/${lang}/text`).toBeGreaterThan(20);
          expect(l?.summary?.length, `${m.key}/${lang}/summary`).toBeGreaterThan(5);
          expect(l?.action?.length, `${m.key}/${lang}/action`).toBeGreaterThan(5);
        }
      }
    }
  });

  it('translations preserve numbers and the emergency number', () => {
    const cy = SCENARIOS.cyclone.messages.find((m) => m.priority === 'CRITICAL');
    for (const lang of LANGUAGE_CODES) {
      expect(cy.i18n[lang].text).toContain('112');
      expect(cy.i18n[lang].text).toContain('140');
      expect(cy.i18n[lang].text).toMatch(/\b5\b/);
    }
  });

  it('non-English text uses the right script', () => {
    const cy = SCENARIOS.cyclone.messages.find((m) => m.priority === 'CRITICAL');
    expect(cy.i18n.ta.text).toMatch(/[஀-௿]/);
    expect(cy.i18n.hi.text).toMatch(/[ऀ-ॿ]/);
    expect(cy.i18n.te.text).toMatch(/[ఀ-౿]/);
  });
});

describe('ultra-compact alert format', () => {
  const critical = SCENARIOS.cyclone.messages.find((m) => m.priority === 'CRITICAL');
  const msg = { id: 'abc123', priority: 'CRITICAL', category: 'CYCLONE', issuedAtSec: 1_800_000_000, expiresAtSec: 1_800_021_600, zone: critical.zone, i18n: critical.i18n };

  it('fits under 1 KB in every language, including multi-byte scripts', () => {
    for (const lang of LANGUAGE_CODES) {
      const p = buildCompactAlert(msg, lang);
      expect(compactSize(p).bytes).toBeLessThanOrEqual(COMPACT_MAX_BYTES);
      expect(p.l).toBe(lang);
      expect(p.h).toBe(critical.i18n[lang].summary);
      expect(p.a).toBe(critical.i18n[lang].action);
    }
  });

  it('never trims the headline or action even when the body must be cut', () => {
    const long = { ...msg, i18n: { en: { ...critical.i18n.en, text: 'x'.repeat(5000) } } };
    const p = buildCompactAlert(long, 'en');
    expect(byteLength(canonicalize(p))).toBeLessThanOrEqual(COMPACT_MAX_BYTES);
    expect(p.h).toBe(critical.i18n.en.summary);
    expect(p.a).toBe(critical.i18n.en.action);
    expect(p.b.endsWith('…')).toBe(true);
  });

  it('falls back to English when the language is missing, and says so', () => {
    const p = buildCompactAlert({ ...msg, i18n: { en: critical.i18n.en } }, 'ta');
    expect(p.l).toBe('en');
  });

  it('throws when there is nothing to send', () => {
    expect(() => buildCompactAlert({ ...msg, i18n: {} }, 'en')).toThrow();
  });

  it('canonicalize is order-independent and drops undefined', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: undefined } })).toBe(canonicalize({ a: { d: 2 }, b: 1 }));
  });

  it('reports transfer time at 50 Kbps', () => {
    const { bytes, secondsAt50Kbps } = compactSize(buildCompactAlert(msg, 'en'));
    expect(secondsAt50Kbps).toBeLessThan(0.2);
    expect(bytes).toBeLessThan(1024);
  });

  it('dataSaved compares a degrading timeline against always-720p', () => {
    const d = dataSaved([{ tier: '720p', seconds: 60 }, { tier: '240p', seconds: 60 }, { tier: 'TEXT', seconds: 60 }], 800);
    expect(d.baselineBytes).toBeGreaterThan(d.sentBytes);
    expect(d.savedBytes).toBe(d.baselineBytes - d.sentBytes);
    expect(dataSaved([{ tier: '720p', seconds: 10 }]).savedBytes).toBe(0);
  });
});

import { haversineKm, inZone, MESH_RANGE_KM } from '../src/index.js';

describe('geo helpers', () => {
  const chennai = { lat: 13.0827, lng: 80.2707 };
  const madurai = { lat: 9.9252, lng: 78.1198 };

  it('haversine matches known distances', () => {
    expect(haversineKm(chennai, chennai)).toBeCloseTo(0, 5);
    const d = haversineKm(chennai, madurai);
    expect(d).toBeGreaterThan(375);
    expect(d).toBeLessThan(440);
  });

  it('no zone means everyone is targeted', () => {
    expect(inZone(chennai, null)).toBe(true);
    expect(inZone(null, undefined)).toBe(true);
  });

  it('a zone targets only receivers inside it', () => {
    const zone = { ...chennai, radiusKm: 25 };
    expect(inZone({ lat: 13.1, lng: 80.3 }, zone)).toBe(true);
    expect(inZone(madurai, zone)).toBe(false);
  });

  it('never guesses: unknown or invalid locations are not targeted by a zone', () => {
    const zone = { ...chennai, radiusKm: 25 };
    for (const loc of [null, undefined, {}, { lat: NaN, lng: 1 }, { lat: 999, lng: 0 }]) expect(inZone(loc, zone)).toBe(false);
  });

  it('mesh range is a short hop', () => {
    expect(MESH_RANGE_KM).toBeLessThanOrEqual(2);
  });
});
