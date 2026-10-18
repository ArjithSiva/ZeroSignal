import { describe, expect, it } from 'vitest';
import { aiStats, bucketSeries, computeAnalytics, deliveryStats, qualityDistribution, transitionCounts } from '../src/services/analytics.js';

const ev = (from, to, trigger = 'REACTIVE', at = 1000) => ({ from, to, trigger, at, receiverId: 'A', direction: 'DOWN', reason: 'r' });

describe('transitionCounts', () => {
  it('counts the four headline transitions and splits reactive vs predictive', () => {
    const t = transitionCounts([ev('720p', '480p'), ev('720p', '480p', 'PREDICTIVE'), ev('480p', '240p'), ev('240p', 'AUDIO'), ev('AUDIO', 'TEXT'), ev('TEXT', 'AUDIO')]);
    expect(t.headline).toEqual([
      { key: '720p→480p', count: 2 }, { key: '480p→240p', count: 1 }, { key: '240p→AUDIO', count: 1 }, { key: 'AUDIO→TEXT', count: 1 },
    ]);
    expect(t).toMatchObject({ total: 6, reactive: 5, predictive: 1, predictiveShare: 16.7 });
    expect(t.pairs[0]).toMatchObject({ key: '720p→480p', count: 2, reactive: 1, predictive: 1 });
  });
  it('handles empty input and ignores initial (from-less) events', () => {
    expect(transitionCounts([])).toMatchObject({ total: 0, predictiveShare: null });
    expect(transitionCounts([{ from: null, to: '720p' }]).total).toBe(0);
  });
});

describe('qualityDistribution', () => {
  it('reports each tier’s share, best tier first', () => {
    const d = qualityDistribution([{ tier: '720p' }, { tier: '720p' }, { tier: 'TEXT' }, { tier: 'AUDIO' }, {}]);
    expect(d[0]).toMatchObject({ tier: '720p', samples: 2, share: 50 });
    expect(d.reduce((a, x) => a + x.share, 0)).toBeCloseTo(100, 0);
    expect(d.map((x) => x.tier)).toEqual(['720p', '480p', '240p', 'AUDIO', 'TEXT', 'CACHED']);
  });
});

describe('deliveryStats', () => {
  const dl = (priority, status, channel = 'TEXT', m = 'm1', r = 'A') => ({ priority, status, channel, messageId: m, receiverId: r });
  it('computes the critical-alert delivery rate (100% when every critical alert landed)', () => {
    const d = deliveryStats([dl('CRITICAL', 'DELIVERED'), dl('CRITICAL', 'ACKED', 'TEXT', 'm1', 'B'), dl('NORMAL', 'DELIVERED')], [], [{ priority: 'CRITICAL', category: 'CYCLONE' }]);
    expect(d.critical).toMatchObject({ total: 2, delivered: 2, rate: 100, pending: 0 });
    expect(d.deliveryRate).toBe(100);
  });
  it('is honest about expired and still-pending critical alerts', () => {
    const d = deliveryStats([dl('CRITICAL', 'DELIVERED'), dl('CRITICAL', 'EXPIRED', 'TEXT', 'm1', 'B'), dl('CRITICAL', 'PENDING', 'SMS_SIMULATED', 'm1', 'C')], [], []);
    expect(d.critical).toMatchObject({ total: 3, delivered: 1, expired: 1, pending: 1 });
    expect(d.critical.rate).toBe(33.3);
    expect(d.byChannel).toEqual({ TEXT: 2, SMS_SIMULATED: 1 });
  });
  it('counts responses and ack rate; no division by zero', () => {
    const d = deliveryStats([dl('HIGH', 'DELIVERED'), dl('HIGH', 'ACKED', 'TEXT', 'm1', 'B')], [{ status: 'SAFE', messageId: 'm1', receiverId: 'B' }, { status: 'NEED_HELP', messageId: 'm1', receiverId: 'C' }, { status: 'RECEIVED', messageId: 'm1', receiverId: 'A' }], []);
    expect(d.responses).toEqual({ safe: 1, needHelp: 1 });
    expect(d.ackRate).toBe(100);
    expect(deliveryStats([], [], [])).toMatchObject({ deliveryRate: null, critical: { rate: null } });
  });
});

describe('aiStats', () => {
  it('summarises calls, failures, fallback share and latency of successful calls', () => {
    const a = aiStats([{ kind: 'analyze', ok: true, source: 'groq', latencyMs: 100 }, { kind: 'analyze', ok: true, source: 'groq', latencyMs: 300 }, { kind: 'translate', ok: false, source: 'fallback' }]);
    expect(a).toMatchObject({ calls: 3, succeeded: 2, failed: 1, fallbackShare: 33.3, avgLatencyMs: 200, byKind: { analyze: 2, translate: 1 } });
    expect(aiStats([])).toMatchObject({ calls: 0, fallbackShare: null, avgLatencyMs: 0 });
  });
});

describe('bucketSeries', () => {
  it('averages samples into time buckets and never exceeds the requested count', () => {
    const s = Array.from({ length: 100 }, (_, i) => ({ ts: i * 1000, bandwidthKbps: i < 50 ? 8000 : 100, latencyMs: 50, packetLoss: 1, jitterMs: 5 }));
    const b = bucketSeries(s, 10);
    expect(b).toHaveLength(10);
    expect(b[0].bandwidthKbps).toBe(8000);
    expect(b[9].bandwidthKbps).toBe(100);
    expect(b.reduce((a, x) => a + x.samples, 0)).toBe(100);
  });
  it('handles empty, single-sample and invalid-timestamp input', () => {
    expect(bucketSeries([])).toEqual([]);
    expect(bucketSeries([{ ts: 5, bandwidthKbps: 10 }])).toHaveLength(1);
    expect(bucketSeries([{ ts: 'nope', bandwidthKbps: 1 }])).toEqual([]);
  });
});

describe('computeAnalytics', () => {
  it('tolerates a completely empty database', () => {
    const a = computeAnalytics({});
    expect(a.totals).toMatchObject({ broadcasts: 0, receivers: 0, avgBroadcastDurationSec: 0 });
    expect(a.network.series).toEqual([]);
    expect(a.delivery.critical.rate).toBeNull();
  });
  it('assembles totals, durations and a sorted, capped timeline', () => {
    const events = Array.from({ length: 300 }, (_, i) => ev('720p', '480p', 'REACTIVE', 300 - i));
    const a = computeAnalytics(
      {
        broadcasts: [{ _id: 'b1', title: 'T', status: 'ENDED', startedAt: new Date(0), endedAt: new Date(120_000) }, { _id: 'b2', title: 'L', status: 'LIVE' }],
        sessions: [{ receiverId: 'A', reconnects: 2 }, { receiverId: 'A', reconnects: 0 }, { receiverId: 'B' }],
        events,
      },
      { nowMs: 0 },
    );
    expect(a.totals).toMatchObject({ broadcasts: 2, liveBroadcasts: 1, receivers: 2, sessions: 3, reconnects: 2, avgBroadcastDurationSec: 120 });
    expect(a.timeline).toHaveLength(200);
    expect(a.timeline[0].at).toBeLessThan(a.timeline[199].at);
  });
});
