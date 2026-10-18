/**
 * ZeroSignal shared constants and the (fully configurable) default engine config.
 * Nothing here is hardcoded into the engine: every threshold is read from a config
 * object, and `mergeConfig()` lets callers override any part of it.
 */

/**
 * @typedef {'720p'|'480p'|'240p'|'AUDIO'|'TEXT'|'CACHED'} Tier
 * @typedef {'RICH_MEDIA'|'LOW_BANDWIDTH'|'AUDIO_PRIORITY'|'CRITICAL_TEXT'|'OFFLINE_CACHE'} Mode
 * @typedef {'LOW'|'NORMAL'|'HIGH'|'CRITICAL'} Priority
 */

/** Tiers in ascending rank: index == rank (CACHED is the floor, 720p the ceiling). */
export const TIERS = Object.freeze(['CACHED', 'TEXT', 'AUDIO', '240p', '480p', '720p']);

export const TIER_RANK = Object.freeze(Object.fromEntries(TIERS.map((t, i) => [t, i])));

export const MODES = Object.freeze({
  RICH_MEDIA: 'RICH_MEDIA',
  LOW_BANDWIDTH: 'LOW_BANDWIDTH',
  AUDIO_PRIORITY: 'AUDIO_PRIORITY',
  CRITICAL_TEXT: 'CRITICAL_TEXT',
  OFFLINE_CACHE: 'OFFLINE_CACHE',
});

export const TIER_MODE = Object.freeze({
  '720p': MODES.RICH_MEDIA,
  '480p': MODES.LOW_BANDWIDTH,
  '240p': MODES.LOW_BANDWIDTH,
  AUDIO: MODES.AUDIO_PRIORITY,
  TEXT: MODES.CRITICAL_TEXT,
  CACHED: MODES.OFFLINE_CACHE,
});

export const PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']);

export const CATEGORIES = Object.freeze([
  'CYCLONE',
  'FLOOD',
  'FIRE',
  'EARTHQUAKE',
  'MEDICAL',
  'OTHER',
]);

export const LANGUAGES = Object.freeze({
  en: { code: 'en', name: 'English', native: 'English', speech: 'en-IN' },
  ta: { code: 'ta', name: 'Tamil', native: 'தமிழ்', speech: 'ta-IN' },
  hi: { code: 'hi', name: 'Hindi', native: 'हिन्दी', speech: 'hi-IN' },
  te: { code: 'te', name: 'Telugu', native: 'తెలుగు', speech: 'te-IN' },
});

export const LANGUAGE_CODES = Object.freeze(Object.keys(LANGUAGES));

/**
 * Default engine configuration. All bandwidth numbers are in Kbps.
 *
 * Bandwidth bands (reference thresholds from the spec):
 *   >= tier720  → 720p      >= tier480 → 480p      >= tier240 → 240p
 *   >= audioEnter → AUDIO   <  audioExit → TEXT
 * The 100–200 Kbps band is a hysteresis "hold band": a receiver already on AUDIO
 * (or better) stays on AUDIO down to `audioExit`; a receiver below AUDIO does not
 * climb to it until `audioEnter` is reached. This keeps audio from flapping.
 */
export const DEFAULT_CONFIG = {
  thresholds: {
    bandwidth: {
      tier720: 8000,
      tier480: 2000,
      tier240: 700,
      audioEnter: 200,
      audioExit: 100,
    },
    /**
     * Impairment rules. The highest matching rule per metric wins; the engine then
     * applies the single worst demotion (max, not sum) across all metrics.
     */
    packetLoss: [
      { gt: 5, steps: 1 },
      { gt: 10, steps: 2 },
      { gt: 20, steps: 3 },
    ],
    latencyMs: [
      { gt: 400, steps: 1 },
      { gt: 800, steps: 2 },
    ],
    jitterMs: [
      { gt: 60, steps: 1 },
      { gt: 120, steps: 2 },
    ],
    stability: [
      { lt: 50, steps: 1 },
      { lt: 25, steps: 2 },
    ],
  },
  hysteresis: {
    /** Consecutive "worse" samples required before a normal downgrade. */
    downConfirm: 2,
    /** Consecutive "better" samples required before a one-step upgrade. */
    upConfirm: 4,
    /** Consecutive online samples required to leave CACHED. */
    reconnectConfirm: 2,
    /** Bandwidth must exceed an upgrade tier's floor by this factor. */
    upMargin: 1.15,
    /** Drops of at least this many tiers skip debouncing. */
    immediateDropSteps: 2,
    /** Samples during which upgrades are blocked after a pre-emptive downgrade. */
    preemptHold: 6,
  },
  priority: {
    /** LOW alerts are deferred when the receiver's tier is at or below this. */
    deferLowAtOrBelow: 'AUDIO',
  },
  predictor: {
    window: 8,
    minSamples: 4,
    horizonSec: 15,
    minConfidence: 0.6,
    ewmaAlpha: 0.4,
  },
};

/** Weights used by the Signal Health Score (must sum to 1). */
export const SIGNAL_WEIGHTS = Object.freeze({
  bandwidth: 0.35,
  latency: 0.15,
  packetLoss: 0.25,
  jitter: 0.1,
  stability: 0.15,
});

/** Palette shared by score labels so client and server agree on colors. */
export const COLORS = Object.freeze({
  bg: '#070B14',
  card: '#0D1422',
  primary: '#22D3EE',
  success: '#22C55E',
  warning: '#F59E0B',
  critical: '#EF4444',
  text: '#F8FAFC',
  muted: '#94A3B8',
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * Throws if a config is internally inconsistent (e.g. non-monotone thresholds).
 * @param {typeof DEFAULT_CONFIG} cfg
 */
export function validateConfig(cfg) {
  const b = cfg.thresholds.bandwidth;
  const ordered =
    b.tier720 > b.tier480 && b.tier480 > b.tier240 && b.tier240 > b.audioEnter && b.audioEnter >= b.audioExit && b.audioExit > 0;
  if (!ordered) {
    throw new Error('Invalid config: bandwidth thresholds must satisfy tier720 > tier480 > tier240 > audioEnter >= audioExit > 0');
  }
  const h = cfg.hysteresis;
  if (!(h.upMargin >= 1)) throw new Error('Invalid config: hysteresis.upMargin must be >= 1');
  for (const key of ['downConfirm', 'upConfirm', 'reconnectConfirm', 'immediateDropSteps']) {
    if (!Number.isInteger(h[key]) || h[key] < 1) {
      throw new Error(`Invalid config: hysteresis.${key} must be an integer >= 1`);
    }
  }
  if (!(cfg.priority.deferLowAtOrBelow in TIER_RANK)) {
    throw new Error('Invalid config: priority.deferLowAtOrBelow must be a known tier');
  }
  return cfg;
}

/**
 * Deep-merge overrides onto the defaults (arrays replace, objects merge) and validate.
 * @param {object} [overrides]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function mergeConfig(overrides = {}) {
  return validateConfig(deepMerge(structuredClone(DEFAULT_CONFIG), overrides));
}
