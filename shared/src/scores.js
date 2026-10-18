/**
 * Signal Intelligence scores. Both functions are pure and documented so the numbers
 * shown in the UI can be explained and tested.
 */
import { COLORS, SIGNAL_WEIGHTS } from './config.js';
import { clamp, round } from './format.js';
import { isOffline, normalizeMetrics } from './engine.js';

const LABELS = [
  { min: 85, label: 'EXCELLENT', color: COLORS.success },
  { min: 70, label: 'GOOD', color: '#84CC16' },
  { min: 50, label: 'MODERATE', color: COLORS.warning },
  { min: 25, label: 'POOR', color: '#F97316' },
  { min: 0, label: 'CRITICAL', color: COLORS.critical },
];

/** @param {number} score 0–100 → { label, color } */
export function labelForScore(score) {
  return LABELS.find((l) => score >= l.min) ?? LABELS[LABELS.length - 1];
}

/**
 * Per-metric sub-scores (0–100):
 *  - bandwidth: log scale, 0 at <=50 Kbps, 100 at >=10 Mbps (video quality is roughly logarithmic in bitrate)
 *  - latency:   linear, 100 at <=30 ms, 0 at >=1000 ms
 *  - packetLoss: linear, 100 at 0%, 0 at >=25%
 *  - jitter:    linear, 100 at <=5 ms, 0 at >=150 ms
 *  - stability: taken as-is (already 0–100)
 */
export function metricScores(metrics) {
  const m = normalizeMetrics(metrics);
  const bw = m.bandwidthKbps <= 50 ? 0 : (Math.log(m.bandwidthKbps / 50) / Math.log(10000 / 50)) * 100;
  return {
    bandwidth: clamp(bw, 0, 100),
    latency: clamp(((1000 - m.latencyMs) / (1000 - 30)) * 100, 0, 100),
    packetLoss: clamp((1 - m.packetLoss / 25) * 100, 0, 100),
    jitter: clamp(((150 - m.jitterMs) / (150 - 5)) * 100, 0, 100),
    stability: clamp(m.stability, 0, 100),
  };
}

/**
 * Signal Health Score: weighted mean of the metric sub-scores (weights in SIGNAL_WEIGHTS:
 * bandwidth 35%, packet loss 25%, latency 15%, stability 15%, jitter 10%). Offline = 0.
 *
 * @returns {{ score: number, label: string, color: string, components: Record<string, {score:number, weight:number, value:number}> }}
 */
export function signalHealthScore(metrics) {
  const m = normalizeMetrics(metrics);
  const sub = metricScores(m);
  const values = { bandwidth: m.bandwidthKbps, latency: m.latencyMs, packetLoss: m.packetLoss, jitter: m.jitterMs, stability: m.stability };
  const components = {};
  let total = 0;
  for (const key of Object.keys(SIGNAL_WEIGHTS)) {
    components[key] = { score: round(sub[key]), weight: SIGNAL_WEIGHTS[key], value: values[key] };
    total += sub[key] * SIGNAL_WEIGHTS[key];
  }
  const score = isOffline(m) ? 0 : clamp(round(total), 0, 100);
  return { score, ...labelForScore(score), components };
}

/** Resolution sub-score per tier (video quality ladder; TEXT still carries the alert). */
export const RESOLUTION_SCORE = Object.freeze({ '720p': 100, '480p': 80, '240p': 55, AUDIO: 40, TEXT: 25, CACHED: 5 });

export const QUALITY_WEIGHTS = Object.freeze({
  resolution: 0.25,
  buffering: 0.15,
  latency: 0.1,
  packetLoss: 0.15,
  audio: 0.1,
  delivery: 0.15,
  stability: 0.1,
});

/**
 * Broadcast Quality Score (0–100) for what a receiver is actually experiencing.
 *
 * @param {object} input
 * @param {string} input.tier              current quality tier
 * @param {number} [input.bufferingRatio]  0–1 share of time spent buffering (0 = none)
 * @param {number} [input.latencyMs]
 * @param {number} [input.packetLoss]      percent
 * @param {number} [input.audioQuality]    0–100; derived from tier/loss when omitted
 * @param {number} [input.deliverySuccess] 0–1 share of alerts delivered (default 1)
 * @param {number} [input.stability]       0–100
 */
export function broadcastQualityScore(input) {
  const tier = input.tier ?? 'CACHED';
  const latencyMs = Number.isFinite(input.latencyMs) ? input.latencyMs : 50;
  const packetLoss = clamp(Number.isFinite(input.packetLoss) ? input.packetLoss : 0, 0, 100);
  const stability = clamp(Number.isFinite(input.stability) ? input.stability : 100, 0, 100);
  const buffering = clamp(Number.isFinite(input.bufferingRatio) ? input.bufferingRatio : 0, 0, 1);
  const delivery = clamp(Number.isFinite(input.deliverySuccess) ? input.deliverySuccess : 1, 0, 1);
  const hasAudio = !['TEXT', 'CACHED'].includes(tier);
  const audio = Number.isFinite(input.audioQuality)
    ? clamp(input.audioQuality, 0, 100)
    : hasAudio
      ? clamp(100 - packetLoss * 4, 0, 100)
      : 0;

  const parts = {
    resolution: RESOLUTION_SCORE[tier] ?? 0,
    buffering: (1 - buffering) * 100,
    latency: clamp(((1000 - latencyMs) / 970) * 100, 0, 100),
    packetLoss: clamp((1 - packetLoss / 25) * 100, 0, 100),
    audio,
    delivery: delivery * 100,
    stability,
  };

  let total = 0;
  for (const key of Object.keys(QUALITY_WEIGHTS)) total += parts[key] * QUALITY_WEIGHTS[key];
  const score = clamp(round(total), 0, 100);
  const components = Object.fromEntries(
    Object.keys(parts).map((k) => [k, { score: round(parts[k]), weight: QUALITY_WEIGHTS[k] }]),
  );
  return { score, ...labelForScore(score), components };
}
