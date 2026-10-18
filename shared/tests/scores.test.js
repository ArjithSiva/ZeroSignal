import { describe, expect, it } from 'vitest';
import {
  broadcastQualityScore,
  ewma,
  labelForScore,
  linearTrend,
  mergeConfig,
  predictDegradation,
  signalHealthScore,
  SIGNAL_WEIGHTS,
  QUALITY_WEIGHTS,
} from '../src/index.js';

const perfect = { bandwidthKbps: 10000, latencyMs: 30, packetLoss: 0, jitterMs: 5, stability: 100 };

describe('Signal Health Score', () => {
  it('weights sum to 1', () => {
    expect(Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('a perfect link scores 100 / EXCELLENT', () => {
    expect(signalHealthScore(perfect)).toMatchObject({ score: 100, label: 'EXCELLENT' });
  });

  it('offline scores 0 / CRITICAL', () => {
    expect(signalHealthScore({ bandwidthKbps: 0 })).toMatchObject({ score: 0, label: 'CRITICAL' });
    expect(signalHealthScore({ ...perfect, online: false }).score).toBe(0);
  });

  it('is monotone: worse metrics never raise the score', () => {
    const base = signalHealthScore({ ...perfect, bandwidthKbps: 3000 }).score;
    expect(signalHealthScore({ ...perfect, bandwidthKbps: 3000, packetLoss: 5 }).score).toBeLessThan(base);
    expect(signalHealthScore({ ...perfect, bandwidthKbps: 3000, latencyMs: 400 }).score).toBeLessThan(base);
    expect(signalHealthScore({ ...perfect, bandwidthKbps: 3000, jitterMs: 80 }).score).toBeLessThan(base);
    expect(signalHealthScore({ ...perfect, bandwidthKbps: 3000, stability: 40 }).score).toBeLessThan(base);
    expect(signalHealthScore({ ...perfect, bandwidthKbps: 800 }).score).toBeLessThan(base);
  });

  it('stays within 0–100 for absurd input', () => {
    for (const metrics of [
      { bandwidthKbps: 1e9, latencyMs: -5, packetLoss: -3, jitterMs: -1, stability: 500 },
      { bandwidthKbps: 1, latencyMs: 1e6, packetLoss: 400, jitterMs: 1e6, stability: -50 },
    ]) {
      const { score } = signalHealthScore(metrics);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('exposes per-metric components for the bars', () => {
    const { components } = signalHealthScore({ ...perfect, packetLoss: 12.5 });
    expect(Object.keys(components).sort()).toEqual(['bandwidth', 'jitter', 'latency', 'packetLoss', 'stability']);
    expect(components.packetLoss.score).toBe(50);
    expect(components.packetLoss.value).toBe(12.5);
  });

  it('maps score bands to labels and colors', () => {
    expect(labelForScore(90).label).toBe('EXCELLENT');
    expect(labelForScore(75).label).toBe('GOOD');
    expect(labelForScore(60).label).toBe('MODERATE');
    expect(labelForScore(30).label).toBe('POOR');
    expect(labelForScore(5).label).toBe('CRITICAL');
    expect(labelForScore(5).color).toBe('#EF4444');
  });
});

describe('Broadcast Quality Score', () => {
  const clean = { tier: '720p', latencyMs: 30, packetLoss: 0, stability: 100, bufferingRatio: 0, deliverySuccess: 1 };

  it('clean 720p is excellent', () => {
    expect(broadcastQualityScore(clean).score).toBeGreaterThanOrEqual(95);
  });

  it('is ordered by tier', () => {
    const scores = ['720p', '480p', '240p', 'AUDIO', 'TEXT', 'CACHED'].map((tier) => broadcastQualityScore({ ...clean, tier }).score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
  });

  it('buffering, loss, latency and failed delivery all lower it', () => {
    const base = broadcastQualityScore(clean).score;
    expect(broadcastQualityScore({ ...clean, bufferingRatio: 0.4 }).score).toBeLessThan(base);
    expect(broadcastQualityScore({ ...clean, packetLoss: 8 }).score).toBeLessThan(base);
    expect(broadcastQualityScore({ ...clean, latencyMs: 600 }).score).toBeLessThan(base);
    expect(broadcastQualityScore({ ...clean, deliverySuccess: 0.5 }).score).toBeLessThan(base);
  });

  it('has no audio component on TEXT/CACHED tiers', () => {
    expect(broadcastQualityScore({ ...clean, tier: 'TEXT' }).components.audio.score).toBe(0);
    expect(broadcastQualityScore({ ...clean, tier: 'CACHED' }).components.audio.score).toBe(0);
  });

  it('survives missing fields and clamps to 0–100', () => {
    expect(broadcastQualityScore({}).score).toBeGreaterThanOrEqual(0);
    const wild = broadcastQualityScore({ tier: '720p', bufferingRatio: -3, deliverySuccess: 9, packetLoss: -1, stability: 900 });
    expect(wild.score).toBeLessThanOrEqual(100);
  });

  it('CRITICAL alerts delivered over a poor link still score above an undelivered one', () => {
    const delivered = broadcastQualityScore({ ...clean, tier: 'TEXT', deliverySuccess: 1 }).score;
    const lost = broadcastQualityScore({ ...clean, tier: 'TEXT', deliverySuccess: 0 }).score;
    expect(delivered).toBeGreaterThan(lost);
  });
});

describe('trend primitives', () => {
  it('ewma weights recent values more', () => {
    expect(ewma([])).toBe(0);
    expect(ewma([10])).toBe(10);
    const v = ewma([10, 10, 10, 100], 0.5);
    expect(v).toBeGreaterThan(10);
    expect(v).toBeLessThan(100);
    expect(ewma([100, 10, 10, 10], 0.5)).toBeLessThan(v);
  });

  it('linearTrend recovers slope and a perfect fit', () => {
    const t = linearTrend([0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 1 })));
    expect(t.slope).toBeCloseTo(2, 10);
    expect(t.intercept).toBeCloseTo(1, 10);
    expect(t.r2).toBeCloseTo(1, 10);
  });

  it('linearTrend handles flat and degenerate series', () => {
    expect(linearTrend([{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }])).toMatchObject({ slope: 0, r2: 0 });
    expect(linearTrend([{ x: 1, y: 5 }])).toMatchObject({ slope: 0, r2: 0 });
    expect(linearTrend([{ x: 1, y: 5 }, { x: 1, y: 9 }]).slope).toBe(0);
  });
});

describe('trend predictor', () => {
  const t0 = 1_700_000_000_000;
  const series = (bws, extra = {}) =>
    bws.map((b, i) => ({ ts: t0 + i * 2000, bandwidthKbps: b, latencyMs: 40, packetLoss: 0, jitterMs: 5, stability: 100, ...extra }));

  it('predicts degradation from a steady decline and recommends one step down', () => {
    const p = predictDegradation(series([9000, 8000, 7000, 6000, 5000, 4000, 3000, 2200]), '720p');
    expect(p.predicted).toBe(true);
    expect(p.recommend).toBe(true);
    expect(p.recommendedTier).toBe('480p');
    expect(p.confidence).toBeGreaterThanOrEqual(0.6);
    expect(p.message).toBe('⚠ Degradation predicted — switching 720p → 480p');
    expect(p.detail).toMatch(/confidence/);
  });

  it('does not recommend on a flat, healthy link', () => {
    const p = predictDegradation(series([9000, 9100, 8900, 9050, 9000, 8950, 9020, 9000]), '720p');
    expect(p.predicted).toBe(false);
    expect(p.recommend).toBe(false);
    expect(p.recommendedTier).toBeNull();
  });

  it('does not recommend on an improving link', () => {
    const p = predictDegradation(series([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]), '480p');
    expect(p.recommend).toBe(false);
  });

  it('needs a minimum number of samples', () => {
    const p = predictDegradation(series([9000, 6000, 3000]), '720p');
    expect(p.recommend).toBe(false);
    expect(p.detail).toMatch(/Need 4 samples/);
  });

  it('low confidence on noisy data suppresses the recommendation', () => {
    const p = predictDegradation(series([9000, 3000, 8500, 2500, 8800, 3100, 8000, 7000]), '720p');
    expect(p.recommend).toBe(false);
  });

  it('predicts from rising packet loss even when bandwidth is steady', () => {
    const samples = [0, 2, 4, 6, 8, 10, 12, 14].map((loss, i) => ({
      ts: t0 + i * 2000, bandwidthKbps: 9000, latencyMs: 40, packetLoss: loss, jitterMs: 5, stability: 100,
    }));
    const p = predictDegradation(samples, '720p');
    expect(p.predicted).toBe(true);
    expect(p.recommendedTier).toBe('480p');
  });

  it('never recommends below the lowest live tier', () => {
    const p = predictDegradation(series([90, 80, 70, 60, 50, 40, 30, 20]), 'TEXT');
    expect(p.recommend).toBe(false);
    expect(p.recommendedTier).toBeNull();
  });

  it('never throws on empty or missing history', () => {
    expect(predictDegradation([], '720p').recommend).toBe(false);
    expect(predictDegradation(series([9000, 8000, 7000, 6000]), null).recommend).toBe(false);
  });

  it('respects a configured confidence floor and horizon', () => {
    const samples = series([9000, 8000, 7000, 6000, 5000, 4000, 3000, 2200]);
    const impossible = predictDegradation(samples, '720p', mergeConfig({ predictor: { minConfidence: 1.1 } }));
    expect(impossible.predicted).toBe(true);
    expect(impossible.recommend).toBe(false);
    const short = predictDegradation(samples, '720p', mergeConfig({ predictor: { horizonSec: 1 } }));
    expect(short.horizonSec).toBe(1);
  });
});
