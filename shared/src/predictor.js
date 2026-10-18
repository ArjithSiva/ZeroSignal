/**
 * Predictive Network Intelligence — deliberately lightweight (no ML).
 *
 * Uses an EWMA for the current "level" and an ordinary-least-squares slope over the most
 * recent samples for the direction of travel, projects `horizonSec` ahead, and asks the
 * engine which tier the projected metrics would support. Confidence is the goodness of fit
 * (R²) of the dominant trend, scaled down while the window is still filling.
 */
import { DEFAULT_CONFIG, TIERS, TIER_RANK } from './config.js';
import { clamp, formatBandwidth, round } from './format.js';
import { computeInstantTier } from './engine.js';

/** Exponentially weighted moving average of a numeric series (oldest → newest). */
export function ewma(values, alpha = 0.4) {
  if (!values.length) return 0;
  let acc = values[0];
  for (let i = 1; i < values.length; i++) acc = alpha * values[i] + (1 - alpha) * acc;
  return acc;
}

/**
 * Ordinary least squares over points {x, y}. Returns slope per x-unit and R² in [0, 1].
 * A flat series has R² 0 (no trend to be confident about).
 */
export function linearTrend(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0, r2: 0 };
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 0 : clamp((sxy * sxy) / (sxx * syy), 0, 1);
  return { slope, intercept, r2 };
}

/**
 * @param {Array<{ ts: number, bandwidthKbps: number, latencyMs?: number, packetLoss?: number, jitterMs?: number, stability?: number }>} samples
 *   recent measurements, oldest first, `ts` in epoch milliseconds
 * @param {string|null} currentTier the receiver's current tier
 * @param {typeof DEFAULT_CONFIG} [config]
 */
export function predictDegradation(samples, currentTier, config = DEFAULT_CONFIG) {
  const p = config.predictor;
  const window = samples.slice(-p.window);
  const base = { predicted: false, recommend: false, currentTier, predictedTier: currentTier, recommendedTier: null, horizonSec: p.horizonSec, confidence: 0, trend: null, message: null, detail: null };

  if (window.length < p.minSamples) return { ...base, detail: `Need ${p.minSamples} samples, have ${window.length}` };
  if (currentTier == null || TIER_RANK[currentTier] <= TIER_RANK.TEXT) {
    return { ...base, detail: 'Already at the lowest live tier' };
  }

  const t0 = window[0].ts;
  const xs = window.map((s) => (s.ts - t0) / 1000);
  const series = (key, fallback) => window.map((s, i) => ({ x: xs[i], y: Number.isFinite(s[key]) ? s[key] : fallback }));

  const bw = linearTrend(series('bandwidthKbps', 0));
  const loss = linearTrend(series('packetLoss', 0));
  const lat = linearTrend(series('latencyMs', 50));
  const level = {
    bandwidth: ewma(series('bandwidthKbps', 0).map((q) => q.y), p.ewmaAlpha),
    loss: ewma(series('packetLoss', 0).map((q) => q.y), p.ewmaAlpha),
    latency: ewma(series('latencyMs', 50).map((q) => q.y), p.ewmaAlpha),
    jitter: ewma(series('jitterMs', 5).map((q) => q.y), p.ewmaAlpha),
    stability: ewma(series('stability', 100).map((q) => q.y), p.ewmaAlpha),
  };

  const projected = {
    bandwidthKbps: Math.max(0, level.bandwidth + bw.slope * p.horizonSec),
    packetLoss: clamp(level.loss + loss.slope * p.horizonSec, 0, 100),
    latencyMs: Math.max(0, level.latency + lat.slope * p.horizonSec),
    jitterMs: level.jitter,
    stability: level.stability,
    online: true,
  };

  const trend = {
    bandwidth: { slopePerSec: round(bw.slope, 1), r2: round(bw.r2, 2), ewma: round(level.bandwidth) },
    packetLoss: { slopePerSec: round(loss.slope, 2), r2: round(loss.r2, 2), ewma: round(level.loss, 1) },
    latency: { slopePerSec: round(lat.slope, 1), r2: round(lat.r2, 2), ewma: round(level.latency) },
    projected,
  };

  const worsening = [
    bw.slope < 0 ? bw.r2 : 0,
    loss.slope > 0 ? loss.r2 : 0,
    lat.slope > 0 ? lat.r2 : 0,
  ];
  const dominantR2 = Math.max(...worsening);
  const fill = Math.min(1, window.length / p.window);
  const confidence = round(dominantR2 * fill, 2);

  const predictedTier = computeInstantTier(projected, config, { currentTier }).tier;
  const degrading = dominantR2 > 0 && TIER_RANK[predictedTier] < TIER_RANK[currentTier];
  const recommend = degrading && confidence >= p.minConfidence;
  const recommendedTier = degrading ? TIERS[TIER_RANK[currentTier] - 1] : null;

  const message = degrading && recommendedTier ? `⚠ Degradation predicted — switching ${currentTier} → ${recommendedTier}` : null;
  const detail = degrading
    ? `Bandwidth trending ${round(bw.slope)} Kbps/s (now ~${formatBandwidth(level.bandwidth)}); projects to ${predictedTier} within ${p.horizonSec}s — confidence ${Math.round(confidence * 100)}%`
    : 'No degrading trend detected';

  return { ...base, predicted: degrading, recommend, predictedTier, recommendedTier, confidence, trend, message, detail };
}
