/**
 * Network simulator math (pure, seedable). SIMULATED: nothing here measures a real network.
 *
 * - PRESETS: EXCELLENT … CRITICAL, OFFLINE.
 * - metricsFromSlider(): one continuous 0–100 slider (0 = Critical, 100 = Excellent).
 * - applyNoise(): realistic variance so metrics look alive.
 * - applyChaos(): random bandwidth dips and packet-loss bursts ("Chaos" button).
 * - sampleCurve(): scripted "degrading over time" scenarios as keyframe curves.
 */
import { clamp, round } from './format.js';

/** @typedef {{ bandwidthKbps:number, latencyMs:number, packetLoss:number, jitterMs:number, stability:number, online:boolean }} NetMetrics */

/** @type {Record<string, NetMetrics>} */
export const PRESETS = Object.freeze({
  EXCELLENT: { bandwidthKbps: 12000, latencyMs: 25, packetLoss: 0.1, jitterMs: 4, stability: 98, online: true },
  GOOD: { bandwidthKbps: 6000, latencyMs: 60, packetLoss: 0.8, jitterMs: 12, stability: 90, online: true },
  MODERATE: { bandwidthKbps: 1500, latencyMs: 140, packetLoss: 2.5, jitterMs: 30, stability: 72, online: true },
  POOR: { bandwidthKbps: 450, latencyMs: 280, packetLoss: 3.5, jitterMs: 45, stability: 55, online: true },
  CRITICAL: { bandwidthKbps: 60, latencyMs: 800, packetLoss: 14, jitterMs: 140, stability: 20, online: true },
  OFFLINE: { bandwidthKbps: 0, latencyMs: 0, packetLoss: 100, jitterMs: 0, stability: 0, online: false },
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/** Slider anchor points, ascending. */
const SLIDER_KEYS = [
  [0, PRESETS.CRITICAL],
  [25, PRESETS.POOR],
  [50, PRESETS.MODERATE],
  [75, PRESETS.GOOD],
  [100, PRESETS.EXCELLENT],
];

const lerp = (a, b, t) => a + (b - a) * t;
const geo = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t));

/**
 * Smoothly interpolate between presets. Bandwidth interpolates geometrically (it spans
 * two orders of magnitude); everything else linearly.
 * @param {number} value slider position 0–100
 * @returns {NetMetrics}
 */
export function metricsFromSlider(value) {
  const v = clamp(Number.isFinite(value) ? value : 0, 0, 100);
  let i = 0;
  while (i < SLIDER_KEYS.length - 2 && v > SLIDER_KEYS[i + 1][0]) i++;
  const [x0, a] = SLIDER_KEYS[i];
  const [x1, b] = SLIDER_KEYS[i + 1];
  const t = (v - x0) / (x1 - x0);
  return {
    bandwidthKbps: round(geo(a.bandwidthKbps, b.bandwidthKbps, t)),
    latencyMs: round(lerp(a.latencyMs, b.latencyMs, t)),
    packetLoss: round(lerp(a.packetLoss, b.packetLoss, t), 2),
    jitterMs: round(lerp(a.jitterMs, b.jitterMs, t)),
    stability: round(lerp(a.stability, b.stability, t)),
    online: true,
  };
}

/** Seedable PRNG (mulberry32): same seed → same sequence. Returns a () => [0,1) function. */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximate standard normal using the Box–Muller transform. */
export function gaussian(rng) {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Add realistic variance. Offline stays offline. `amount` 0 disables noise, 1 is normal.
 * @param {NetMetrics} base
 * @param {() => number} rng
 * @param {number} [amount]
 * @returns {NetMetrics}
 */
export function applyNoise(base, rng, amount = 1) {
  if (!base.online || base.bandwidthKbps <= 0 || amount <= 0) return { ...base };
  const wobble = (1 - base.stability / 130) * 0.5 + 0.04; // flakier links vary more
  return {
    bandwidthKbps: round(Math.max(5, base.bandwidthKbps * (1 + gaussian(rng) * wobble * amount))),
    latencyMs: round(Math.max(5, base.latencyMs * (1 + gaussian(rng) * 0.12 * amount))),
    packetLoss: round(clamp(base.packetLoss * (1 + gaussian(rng) * 0.25 * amount) + Math.abs(gaussian(rng)) * 0.05 * amount, 0, 60), 2),
    jitterMs: round(Math.max(1, base.jitterMs * (1 + gaussian(rng) * 0.2 * amount))),
    stability: round(clamp(base.stability + gaussian(rng) * 3 * amount, 0, 100)),
    online: true,
  };
}

/**
 * "Chaos" button: occasional bandwidth collapses and packet-loss bursts layered on top
 * of whatever the base conditions are. `intensity` 0–1.
 */
export function applyChaos(m, rng, intensity = 0.5) {
  if (!m.online || m.bandwidthKbps <= 0) return { ...m };
  const out = { ...m };
  const roll = rng();
  if (roll < 0.35 * intensity) {
    out.bandwidthKbps = round(Math.max(20, m.bandwidthKbps * (0.05 + rng() * 0.3)));
    out.stability = round(clamp(m.stability - 30, 0, 100));
  } else if (roll < 0.7 * intensity) {
    out.packetLoss = round(clamp(m.packetLoss + 6 + rng() * 14 * intensity, 0, 80), 2);
    out.jitterMs = round(m.jitterMs + 40 + rng() * 80);
  } else if (roll < 0.85 * intensity) {
    out.latencyMs = round(m.latencyMs + 300 + rng() * 700);
  }
  return out;
}

/**
 * @typedef {object} Keyframe
 * @property {number} t           seconds from scenario start
 * @property {number} [slider]    0–100 position (smoothly interpolated between keyframes)
 * @property {boolean} [offline]  true → the link is down at this keyframe (step change, not interpolated)
 */

/**
 * Sample a scripted curve at time `t` (seconds). Offline keyframes are step changes.
 * @param {Keyframe[]} curve keyframes sorted by `t`
 * @param {number} t
 * @returns {NetMetrics}
 */
export function sampleCurve(curve, t) {
  if (!curve.length) return { ...PRESETS.EXCELLENT };
  if (t <= curve[0].t) return curve[0].offline ? { ...PRESETS.OFFLINE } : metricsFromSlider(curve[0].slider ?? 100);
  const last = curve[curve.length - 1];
  if (t >= last.t) return last.offline ? { ...PRESETS.OFFLINE } : metricsFromSlider(last.slider ?? 0);
  let i = 0;
  while (i < curve.length - 2 && t >= curve[i + 1].t) i++;
  const a = curve[i];
  const b = curve[i + 1];
  if (a.offline) return { ...PRESETS.OFFLINE };
  if (b.offline) return metricsFromSlider(a.slider ?? 0);
  const f = (t - a.t) / (b.t - a.t);
  return metricsFromSlider(lerp(a.slider ?? 0, b.slider ?? 0, f));
}

/** The generic "degrading over time" scenario (Excellent → … → Critical over `durationSec`). */
export function degradingCurve(durationSec = 120) {
  return [
    { t: 0, slider: 100 },
    { t: durationSec * 0.15, slider: 95 },
    { t: durationSec * 0.45, slider: 55 },
    { t: durationSec * 0.7, slider: 28 },
    { t: durationSec, slider: 4 },
  ];
}

/** Slider position that best matches a metrics snapshot (for the UI to reflect presets). */
export function sliderFromBandwidth(kbps) {
  if (!(kbps > 0)) return 0;
  let best = 0;
  let bestErr = Infinity;
  for (let v = 0; v <= 100; v++) {
    const err = Math.abs(Math.log(metricsFromSlider(v).bandwidthKbps) - Math.log(kbps));
    if (err < bestErr) {
      bestErr = err;
      best = v;
    }
  }
  return best;
}
