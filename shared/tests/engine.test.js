import { describe, expect, it } from 'vitest';
import {
  applyPreemptive,
  buildQualityEvent,
  computeInstantTier,
  createEngineState,
  decide,
  mergeConfig,
  planDelivery,
  DEFAULT_CONFIG,
} from '../src/index.js';

const good = { latencyMs: 40, packetLoss: 0, jitterMs: 5, stability: 100 };
const m = (bandwidthKbps, extra = {}) => ({ ...good, bandwidthKbps, ...extra });

/** Feed a sequence of metrics through the engine, returning every decision. */
function run(samples, priority = 'NORMAL', config = DEFAULT_CONFIG, start = createEngineState()) {
  let state = start;
  const decisions = [];
  for (const s of samples) {
    const r = decide(s, priority, state, config);
    state = r.state;
    decisions.push(r.decision);
  }
  return { decisions, state };
}

describe('instant tier thresholds (spec §11)', () => {
  it.each([
    [8000, '720p', 'RICH_MEDIA'],
    [12000, '720p', 'RICH_MEDIA'],
    [2000, '480p', 'LOW_BANDWIDTH'],
    [7999, '480p', 'LOW_BANDWIDTH'],
    [700, '240p', 'LOW_BANDWIDTH'],
    [1999, '240p', 'LOW_BANDWIDTH'],
    [200, 'AUDIO', 'AUDIO_PRIORITY'],
    [699, 'AUDIO', 'AUDIO_PRIORITY'],
    [99, 'TEXT', 'CRITICAL_TEXT'],
    [80, 'TEXT', 'CRITICAL_TEXT'],
    [50, 'TEXT', 'CRITICAL_TEXT'],
  ])('%i Kbps → %s (%s)', (bw, tier, mode) => {
    const { decision } = decide(m(bw));
    expect(decision.tier).toBe(tier);
    expect(decision.mode).toBe(mode);
  });

  it('no connectivity → CACHED / OFFLINE_CACHE', () => {
    for (const metrics of [{ bandwidthKbps: 0 }, m(5000, { online: false }), m(5000, { packetLoss: 100 })]) {
      const { decision } = decide(metrics);
      expect(decision.tier).toBe('CACHED');
      expect(decision.mode).toBe('OFFLINE_CACHE');
    }
  });

  it('missing bandwidth is treated as offline, not as a crash', () => {
    expect(computeInstantTier({}).tier).toBe('CACHED');
    expect(computeInstantTier(undefined).tier).toBe('CACHED');
  });

  it('bandwidth between 100 and 200 Kbps is a TEXT/AUDIO hold band', () => {
    expect(computeInstantTier(m(150)).tier).toBe('TEXT');
    expect(computeInstantTier(m(150), DEFAULT_CONFIG, { currentTier: 'AUDIO' }).tier).toBe('AUDIO');
    expect(computeInstantTier(m(90), DEFAULT_CONFIG, { currentTier: 'AUDIO' }).tier).toBe('TEXT');
  });
});

describe('impairments demote a tier even when bandwidth is high', () => {
  it('packet loss 7.8% demotes 480p → 240p with an explainable reason', () => {
    const r = computeInstantTier(m(3000, { packetLoss: 7.8 }));
    expect(r.bandwidthTier).toBe('480p');
    expect(r.tier).toBe('240p');
    expect(r.reason).toBe('Packet loss 7.8% exceeds 5% → demoted 480p → 240p');
  });

  it('high latency demotes one step; very high demotes two', () => {
    expect(computeInstantTier(m(9000, { latencyMs: 500 })).tier).toBe('480p');
    expect(computeInstantTier(m(9000, { latencyMs: 900 })).tier).toBe('240p');
  });

  it('jitter and instability also demote', () => {
    expect(computeInstantTier(m(9000, { jitterMs: 80 })).tier).toBe('480p');
    expect(computeInstantTier(m(9000, { stability: 20 })).tier).toBe('480p'.replace('480p', '240p'));
  });

  it('applies the single worst demotion, not the sum', () => {
    const r = computeInstantTier(m(9000, { packetLoss: 6, latencyMs: 500, jitterMs: 70 }));
    expect(r.tier).toBe('480p');
  });

  it('impairments never push a live receiver to CACHED', () => {
    const r = computeInstantTier(m(300, { packetLoss: 60 }));
    expect(['TEXT', 'AUDIO']).toContain(r.tier);
    expect(r.tier).not.toBe('CACHED');
  });

  it('exposes the tripped rules for the explainability panel', () => {
    const r = computeInstantTier(m(3000, { packetLoss: 7.8 }));
    expect(r.factors.impairments[0]).toMatchObject({ metric: 'packetLoss', threshold: 5, steps: 1 });
    expect(r.factors.bandwidth.thresholds.tier480).toBe(2000);
  });
});

describe('configurable thresholds', () => {
  it('honours overridden bandwidth thresholds', () => {
    const cfg = mergeConfig({ thresholds: { bandwidth: { tier720: 20000, tier480: 5000 } } });
    expect(computeInstantTier(m(8000), cfg).tier).toBe('480p');
    expect(computeInstantTier(m(3000), cfg).tier).toBe('240p');
  });

  it('does not mutate the defaults', () => {
    mergeConfig({ thresholds: { bandwidth: { tier720: 99999 } } });
    expect(DEFAULT_CONFIG.thresholds.bandwidth.tier720).toBe(8000);
  });

  it('rejects inconsistent thresholds', () => {
    expect(() => mergeConfig({ thresholds: { bandwidth: { tier480: 9000 } } })).toThrow(/thresholds/);
    expect(() => mergeConfig({ hysteresis: { upMargin: 0.5 } })).toThrow(/upMargin/);
  });

  it('honours overridden hysteresis and impairment rules', () => {
    const cfg = mergeConfig({ hysteresis: { downConfirm: 1 }, thresholds: { packetLoss: [{ gt: 2, steps: 1 }] } });
    expect(computeInstantTier(m(9000, { packetLoss: 3 }), cfg).tier).toBe('480p');
    const { decisions } = run([m(9000), m(3000)], 'NORMAL', cfg);
    expect(decisions[1].tier).toBe('480p');
  });
});

describe('hysteresis / debounce', () => {
  it('first sample adopts the tier without counting as a transition', () => {
    const { decision } = decide(m(9000));
    expect(decision.initial).toBe(true);
    expect(decision.changed).toBe(false);
    expect(buildQualityEvent(decision)).toBeNull();
  });

  it('requires consecutive confirmations before a one-step downgrade', () => {
    const { decisions } = run([m(9000), m(3000), m(3000)]);
    expect(decisions[1]).toMatchObject({ tier: '720p', held: true, changed: false });
    expect(decisions[1].reason).toMatch(/confirming 1\/2/);
    expect(decisions[2]).toMatchObject({ tier: '480p', changed: true, from: '720p', trigger: 'REACTIVE' });
  });

  it('a single dip then recovery never changes tier (no flapping)', () => {
    const { decisions } = run([m(9000), m(3000), m(9000), m(3000), m(9000), m(3000), m(9000)]);
    expect(decisions.every((d) => d.tier === '720p')).toBe(true);
    expect(decisions.some((d) => d.changed)).toBe(false);
  });

  it('drops of two or more tiers react immediately', () => {
    const { decisions } = run([m(9000), m(300)]);
    expect(decisions[1]).toMatchObject({ tier: 'AUDIO', changed: true });
    expect(decisions[1].reason).toMatch(/severe drop/);
  });

  it('losing connectivity reacts immediately', () => {
    const { decisions } = run([m(9000), { bandwidthKbps: 0, online: false }]);
    expect(decisions[1]).toMatchObject({ tier: 'CACHED', mode: 'OFFLINE_CACHE', changed: true });
  });

  it('upgrades climb one tier at a time after sustained recovery', () => {
    const start = run([m(300)]).state; // AUDIO
    const { decisions } = run(Array.from({ length: 12 }, () => m(12000)), 'NORMAL', DEFAULT_CONFIG, start);
    const changes = decisions.filter((d) => d.changed);
    expect(changes.map((d) => d.tier)).toEqual(['240p', '480p', '720p']);
    expect(changes[0].from).toBe('AUDIO');
    expect(changes[0].reason).toMatch(/Recovered/);
  });

  it('upgrade needs headroom: sitting right on a threshold does not upgrade', () => {
    const start = run([m(300)]).state; // AUDIO
    const { decisions } = run(Array.from({ length: 10 }, () => m(710)), 'NORMAL', DEFAULT_CONFIG, start);
    expect(decisions.every((d) => d.tier === 'AUDIO')).toBe(true);
    expect(decisions.at(-1).reason).toMatch(/headroom/);
  });

  it('bandwidth jittering around a boundary does not flap', () => {
    const wobble = [2100, 1950, 2050, 1980, 2020, 1990, 2060, 1970, 2040, 1960, 2030, 1999];
    const { decisions } = run([m(3000), ...wobble.map((b) => m(b))]);
    expect(decisions.filter((d) => d.changed).length).toBeLessThanOrEqual(1);
  });

  it('reconnecting needs sustained connectivity before leaving CACHED', () => {
    const start = run([m(9000), { bandwidthKbps: 0, online: false }]).state;
    const { decisions } = run([m(9000), m(9000)], 'NORMAL', DEFAULT_CONFIG, start);
    expect(decisions[0]).toMatchObject({ tier: 'CACHED', held: true });
    expect(decisions[1]).toMatchObject({ from: 'CACHED', tier: 'TEXT', changed: true });
  });

  it('is pure: the input state is never mutated', () => {
    const s0 = run([m(9000)]).state;
    const frozen = Object.freeze({ ...s0 });
    expect(() => decide(m(3000), 'NORMAL', frozen)).not.toThrow();
    expect(s0.tier).toBe('720p');
  });
});

describe('priority handling', () => {
  it('CRITICAL downgrades with no debounce', () => {
    const { decisions } = run([m(9000), m(3000)], 'CRITICAL');
    expect(decisions[1]).toMatchObject({ tier: '480p', changed: true });
    expect(decisions[1].reason).toMatch(/CRITICAL priority/);
  });

  it('CRITICAL is never dropped and is delivered TEXT-first at every live tier', () => {
    for (const tier of ['720p', '480p', '240p', 'AUDIO', 'TEXT']) {
      const plan = planDelivery(tier, 'CRITICAL');
      expect(plan.neverDropped).toBe(true);
      expect(plan.deferred).toBe(false);
      expect(plan.primary).toBe('TEXT');
      expect(plan.channels).toContain('TEXT');
    }
  });

  it('CRITICAL adds audio when the tier allows it, and not at TEXT', () => {
    expect(planDelivery('AUDIO', 'CRITICAL').channels).toEqual(['TEXT', 'AUDIO']);
    expect(planDelivery('480p', 'CRITICAL').channels).toEqual(['TEXT', 'AUDIO', 'VIDEO']);
    expect(planDelivery('TEXT', 'CRITICAL').channels).toEqual(['TEXT']);
  });

  it('CRITICAL while offline is queued with SMS fallback — never claimed delivered', () => {
    const plan = planDelivery('CACHED', 'CRITICAL');
    expect(plan.neverDropped).toBe(true);
    expect(plan.queued).toBe(true);
    expect(plan.channels).toEqual([]);
    expect(plan.fallbacks).toContain('SMS_SIMULATED');
    expect(plan.note).toMatch(/cached Last verified alert/);
  });

  it('LOW priority is deferred on poor networks but not on good ones', () => {
    expect(planDelivery('AUDIO', 'LOW').deferred).toBe(true);
    expect(planDelivery('TEXT', 'LOW').deferred).toBe(true);
    expect(planDelivery('240p', 'LOW').deferred).toBe(false);
    expect(planDelivery('720p', 'LOW').deferred).toBe(false);
  });

  it('only LOW is ever deferred', () => {
    for (const p of ['NORMAL', 'HIGH', 'CRITICAL']) expect(planDelivery('TEXT', p).deferred).toBe(false);
  });

  it('unknown priority falls back to NORMAL', () => {
    expect(decide(m(9000), 'BOGUS').decision.priority).toBe('NORMAL');
  });
});

describe('explainability and quality events', () => {
  it('every decision carries a non-empty human-readable reason', () => {
    const { decisions } = run([m(9000), m(3000), m(3000), m(300), { bandwidthKbps: 0 }]);
    for (const d of decisions) expect(d.reason.length).toBeGreaterThan(10);
  });

  it('every transition yields a complete quality event', () => {
    const { decisions } = run([m(9000), m(3000), m(3000)]);
    const evt = buildQualityEvent(decisions[2], { at: '2026-10-12T10:00:00Z', receiverId: 'r1', broadcastId: 'b1' });
    expect(evt).toMatchObject({
      from: '720p',
      to: '480p',
      direction: 'DOWN',
      trigger: 'REACTIVE',
      toMode: 'LOW_BANDWIDTH',
      receiverId: 'r1',
      broadcastId: 'b1',
    });
    expect(evt.reason).toBeTruthy();
    expect(evt.metrics.bandwidthKbps).toBe(3000);
  });

  it('walks the full ladder 720p → 480p → 240p → AUDIO → TEXT → CACHED', () => {
    const { decisions } = run([
      m(9000), m(3000), m(3000), m(1000), m(1000), m(300), m(300), m(60), m(60), { bandwidthKbps: 0, online: false },
    ]);
    const path = decisions.filter((d) => d.changed || d.initial).map((d) => d.tier);
    expect(path).toEqual(['720p', '480p', '240p', 'AUDIO', 'TEXT', 'CACHED']);
  });
});

describe('pre-emptive switching', () => {
  const prediction = {
    recommend: true,
    recommendedTier: '480p',
    predictedTier: '240p',
    horizonSec: 15,
    confidence: 0.9,
    trend: {},
    message: '⚠ Degradation predicted — switching 720p → 480p',
    detail: 'Bandwidth trending down',
  };

  it('downgrades one tier immediately and labels it PREDICTIVE', () => {
    const s = run([m(9000)]).state;
    const r = applyPreemptive(s, prediction, m(8200));
    expect(r.decision).toMatchObject({ tier: '480p', from: '720p', changed: true, trigger: 'PREDICTIVE' });
    expect(buildQualityEvent(r.decision).trigger).toBe('PREDICTIVE');
  });

  it('blocks flapping back up during the hold window', () => {
    const s = run([m(9000)]).state;
    const pre = applyPreemptive(s, prediction, m(8200));
    const { decisions } = run(Array.from({ length: 5 }, () => m(12000)), 'NORMAL', DEFAULT_CONFIG, pre.state);
    expect(decisions.every((d) => d.tier === '480p')).toBe(true);
    expect(decisions[0].reason).toMatch(/pre-emptive/);
  });

  it('ignores non-actionable predictions', () => {
    const s = run([m(9000)]).state;
    expect(applyPreemptive(s, { ...prediction, recommend: false }, m(9000))).toBeNull();
    expect(applyPreemptive(s, { ...prediction, recommendedTier: '720p' }, m(9000))).toBeNull();
    expect(applyPreemptive(createEngineState(), prediction, m(9000))).toBeNull();
  });
});
