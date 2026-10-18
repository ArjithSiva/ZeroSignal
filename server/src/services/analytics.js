/**
 * Analytics. Pure functions over plain arrays (lean MongoDB documents), so the maths is unit
 * tested without a database; the routes just fetch the arrays and call computeAnalytics().
 */
import { TIERS } from '@zerosignal/shared';

const ms = (d) => (d instanceof Date ? d.getTime() : typeof d === 'number' ? d : d ? new Date(d).getTime() : NaN);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (n) => Math.round(n * 10) / 10;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** The four "headline" transitions from the spec, in order. */
export const HEADLINE_TRANSITIONS = ['720p→480p', '480p→240p', '240p→AUDIO', 'AUDIO→TEXT'];

/** Average metrics into `buckets` equal time slices between the first and last sample. */
export function bucketSeries(samples, buckets = 24) {
  const pts = samples.map((s) => ({ ...s, t: ms(s.ts) })).filter((s) => Number.isFinite(s.t));
  if (!pts.length) return [];
  const min = Math.min(...pts.map((p) => p.t));
  const max = Math.max(...pts.map((p) => p.t));
  const span = Math.max(1, max - min);
  const n = Math.min(buckets, pts.length);
  const groups = Array.from({ length: n }, () => []);
  for (const p of pts) groups[Math.min(n - 1, Math.floor(((p.t - min) / span) * n))].push(p);
  return groups
    .map((g, i) => (g.length ? { t: Math.round(min + ((i + 0.5) / n) * span), bandwidthKbps: Math.round(avg(g.map((x) => x.bandwidthKbps ?? 0))), latencyMs: Math.round(avg(g.map((x) => x.latencyMs ?? 0))), packetLoss: r1(avg(g.map((x) => x.packetLoss ?? 0))), jitterMs: Math.round(avg(g.map((x) => x.jitterMs ?? 0))), samples: g.length } : null))
    .filter(Boolean);
}

export function transitionCounts(events) {
  const pairs = {};
  const kinds = { reactive: 0, predictive: 0 };
  for (const e of events) {
    if (!e.from || !e.to) continue;
    const key = `${e.from}→${e.to}`;
    pairs[key] ??= { key, from: e.from, to: e.to, count: 0, reactive: 0, predictive: 0 };
    pairs[key].count += 1;
    if (e.trigger === 'PREDICTIVE') {
      pairs[key].predictive += 1;
      kinds.predictive += 1;
    } else {
      pairs[key].reactive += 1;
      kinds.reactive += 1;
    }
  }
  const total = kinds.reactive + kinds.predictive;
  return {
    pairs: Object.values(pairs).sort((a, b) => b.count - a.count),
    headline: HEADLINE_TRANSITIONS.map((key) => ({ key, count: pairs[key]?.count ?? 0 })),
    total,
    reactive: kinds.reactive,
    predictive: kinds.predictive,
    predictiveShare: pct(kinds.predictive, total),
  };
}

export function qualityDistribution(metrics) {
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));
  let total = 0;
  for (const m of metrics) {
    if (m.tier && m.tier in counts) {
      counts[m.tier] += 1;
      total += 1;
    }
  }
  return [...TIERS].reverse().map((tier) => ({ tier, samples: counts[tier], share: pct(counts[tier], total) ?? 0 }));
}

export function deliveryStats(deliveries, acks, messages) {
  const done = (d) => d.status === 'DELIVERED' || d.status === 'ACKED';
  const critical = deliveries.filter((d) => d.priority === 'CRITICAL');
  const criticalDelivered = critical.filter(done).length;
  const criticalFailed = critical.filter((d) => d.status === 'EXPIRED').length;
  const criticalPending = critical.length - criticalDelivered - criticalFailed;
  const responded = new Set(acks.filter((a) => a.status === 'SAFE' || a.status === 'NEED_HELP').map((a) => `${a.messageId}::${a.receiverId}`)).size;
  const byChannel = {};
  for (const d of deliveries) byChannel[d.channel ?? 'TEXT'] = (byChannel[d.channel ?? 'TEXT'] ?? 0) + 1;
  return {
    totalDeliveries: deliveries.length,
    delivered: deliveries.filter(done).length,
    deliveryRate: pct(deliveries.filter(done).length, deliveries.length),
    critical: { total: critical.length, delivered: criticalDelivered, expired: criticalFailed, pending: criticalPending, rate: pct(criticalDelivered, critical.length) },
    acknowledged: deliveries.filter((d) => d.status === 'ACKED').length,
    ackRate: pct(responded, deliveries.length),
    responses: { safe: acks.filter((a) => a.status === 'SAFE').length, needHelp: acks.filter((a) => a.status === 'NEED_HELP').length },
    byChannel,
    messagesByPriority: Object.fromEntries(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'].map((p) => [p, messages.filter((m) => m.priority === p).length])),
    messagesByCategory: messages.reduce((acc, m) => ({ ...acc, [m.category]: (acc[m.category] ?? 0) + 1 }), {}),
  };
}

export function aiStats(usage) {
  const ok = usage.filter((u) => u.ok);
  const lat = ok.map((u) => u.latencyMs).filter(Number.isFinite);
  return {
    calls: usage.length,
    succeeded: ok.length,
    failed: usage.length - ok.length,
    fallbackShare: pct(usage.filter((u) => u.source === 'fallback').length, usage.length),
    avgLatencyMs: Math.round(avg(lat)),
    byKind: usage.reduce((acc, u) => ({ ...acc, [u.kind]: (acc[u.kind] ?? 0) + 1 }), {}),
  };
}

export function broadcastDurations(broadcasts, nowMs = Date.now()) {
  return broadcasts
    .filter((b) => b.startedAt)
    .map((b) => {
      const start = ms(b.startedAt);
      const end = b.endedAt ? ms(b.endedAt) : nowMs;
      return { id: String(b._id), title: b.title, status: b.status, durationSec: Math.max(0, Math.round((end - start) / 1000)) };
    });
}

/**
 * @param {object} d
 * @returns {object} everything the Analytics page renders
 */
export function computeAnalytics({ broadcasts = [], messages = [], metrics = [], events = [], sessions = [], deliveries = [], acks = [], aiUsage = [] }, { nowMs = Date.now(), buckets = 24 } = {}) {
  const receiverIds = new Set(sessions.map((s) => s.receiverId));
  const durations = broadcastDurations(broadcasts, nowMs);
  const transitions = transitionCounts(events);
  const delivery = deliveryStats(deliveries, acks, messages);
  return {
    totals: {
      broadcasts: broadcasts.length,
      liveBroadcasts: broadcasts.filter((b) => b.status === 'LIVE').length,
      messages: messages.length,
      receivers: receiverIds.size,
      sessions: sessions.length,
      reconnects: sessions.reduce((a, s) => a + (s.reconnects ?? 0), 0),
      qualityEvents: events.length,
      metricSamples: metrics.length,
      avgBroadcastDurationSec: Math.round(avg(durations.map((d) => d.durationSec))),
    },
    network: {
      series: bucketSeries(metrics, buckets),
      avg: {
        bandwidthKbps: Math.round(avg(metrics.map((m) => m.bandwidthKbps ?? 0))),
        latencyMs: Math.round(avg(metrics.map((m) => m.latencyMs ?? 0))),
        packetLoss: r1(avg(metrics.map((m) => m.packetLoss ?? 0))),
        jitterMs: Math.round(avg(metrics.map((m) => m.jitterMs ?? 0))),
        healthScore: Math.round(avg(metrics.map((m) => m.healthScore).filter(Number.isFinite))),
      },
    },
    adaptation: transitions,
    quality: { distribution: qualityDistribution(metrics) },
    delivery,
    ai: aiStats(aiUsage),
    durations,
    timeline: events
      .map((e) => ({ at: ms(e.at), receiverId: e.receiverId, from: e.from, to: e.to, direction: e.direction, trigger: e.trigger, reason: e.reason }))
      .sort((a, b) => a.at - b.at)
      .slice(-200),
  };
}
