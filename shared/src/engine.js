/**
 * ZeroSignal Adaptive Engine.
 *
 * Pure, deterministic, dependency-free. No React, no Express, no clock, no randomness:
 * the same (metrics, priority, state, config) always yields the same decision.
 * Groq never participates here — quality tiers are decided by rules only.
 *
 * Flow:  metrics → computeInstantTier() → hysteresis → decide() → { decision, state }
 */
import { DEFAULT_CONFIG, PRIORITIES, TIERS, TIER_MODE, TIER_RANK } from './config.js';
import { clamp, formatBandwidth, formatPercent } from './format.js';

/**
 * @typedef {object} Metrics
 * @property {number} bandwidthKbps
 * @property {number} [latencyMs]
 * @property {number} [packetLoss]  percent 0–100
 * @property {number} [jitterMs]
 * @property {number} [stability]   0–100 (100 = perfectly steady link)
 * @property {boolean} [online]
 *
 * @typedef {object} EngineState
 * @property {string|null} tier
 * @property {'UP'|'DOWN'|null} pendingDirection
 * @property {number} pendingCount
 * @property {number} preemptHold
 */

const rank = (tier) => TIER_RANK[tier];

/** Fresh per-receiver engine state. Treat as immutable; `decide` returns a new one. */
export function createEngineState() {
  return { tier: null, pendingDirection: null, pendingCount: 0, preemptHold: 0 };
}

/**
 * Fill defaults and clamp. A missing/zero bandwidth means "no connectivity".
 * @param {Partial<Metrics>} [m]
 * @returns {Required<Metrics>}
 */
export function normalizeMetrics(m = {}) {
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    bandwidthKbps: Number.isFinite(m.bandwidthKbps) ? Math.max(0, m.bandwidthKbps) : 0,
    latencyMs: Math.max(0, num(m.latencyMs, 50)),
    packetLoss: clamp(num(m.packetLoss, 0), 0, 100),
    jitterMs: Math.max(0, num(m.jitterMs, 5)),
    stability: clamp(num(m.stability, 100), 0, 100),
    online: m.online !== false,
  };
}

/** True when no new data can arrive at all. */
export function isOffline(m) {
  return m.online === false || !(m.bandwidthKbps > 0) || m.packetLoss >= 100;
}

/**
 * Tier implied by bandwidth alone.
 * @param {number} bw Kbps
 * @param {typeof DEFAULT_CONFIG} cfg
 * @param {{ currentTier?: string|null, scale?: number }} [ctx]
 *   `scale` multiplies the *entry* thresholds (used for upgrade headroom);
 *   `currentTier` enables the AUDIO hold band.
 */
export function computeBandwidthTier(bw, cfg, ctx = {}) {
  const t = cfg.thresholds.bandwidth;
  const s = ctx.scale ?? 1;
  if (bw >= t.tier720 * s) return '720p';
  if (bw >= t.tier480 * s) return '480p';
  if (bw >= t.tier240 * s) return '240p';
  if (bw >= t.audioEnter * s) return 'AUDIO';
  const onAudioOrBetter = ctx.currentTier != null && rank(ctx.currentTier) >= rank('AUDIO');
  if (bw >= t.audioExit && onAudioOrBetter) return 'AUDIO';
  return 'TEXT';
}

function bandwidthReason(bw, tier, cfg) {
  const t = cfg.thresholds.bandwidth;
  const f = formatBandwidth;
  switch (tier) {
    case '720p':
      return `Bandwidth ${f(bw)} ≥ ${f(t.tier720)} → 720p`;
    case '480p':
      return `Bandwidth ${f(bw)} ≥ ${f(t.tier480)} → 480p`;
    case '240p':
      return `Bandwidth ${f(bw)} ≥ ${f(t.tier240)} → 240p`;
    case 'AUDIO':
      return bw >= t.audioEnter
        ? `Bandwidth ${f(bw)} ≥ ${f(t.audioEnter)} → AUDIO`
        : `Bandwidth ${f(bw)} within the ${f(t.audioExit)}–${f(t.audioEnter)} hold band → AUDIO retained`;
    default:
      return bw >= t.audioExit
        ? `Bandwidth ${f(bw)} < ${f(t.audioEnter)} audio threshold → TEXT`
        : `Bandwidth ${f(bw)} < ${f(t.audioExit)} → TEXT`;
  }
}

/**
 * Every impairment rule currently tripped (highest matching rule per metric).
 * Used both to demote tiers and to power the "Why this decision?" panel.
 */
export function collectImpairments(m, cfg) {
  const th = cfg.thresholds;
  const out = [];

  const pick = (rules, test) => {
    let best = null;
    for (const r of rules) if (test(r) && (!best || r.steps > best.steps)) best = r;
    return best;
  };

  const loss = pick(th.packetLoss, (r) => m.packetLoss > r.gt);
  if (loss) {
    out.push({ metric: 'packetLoss', value: m.packetLoss, threshold: loss.gt, steps: loss.steps,
      text: `Packet loss ${formatPercent(m.packetLoss)} exceeds ${loss.gt}%` });
  }
  const lat = pick(th.latencyMs, (r) => m.latencyMs > r.gt);
  if (lat) {
    out.push({ metric: 'latencyMs', value: m.latencyMs, threshold: lat.gt, steps: lat.steps,
      text: `Latency ${Math.round(m.latencyMs)} ms exceeds ${lat.gt} ms` });
  }
  const jit = pick(th.jitterMs, (r) => m.jitterMs > r.gt);
  if (jit) {
    out.push({ metric: 'jitterMs', value: m.jitterMs, threshold: jit.gt, steps: jit.steps,
      text: `Jitter ${Math.round(m.jitterMs)} ms exceeds ${jit.gt} ms` });
  }
  const stab = pick(th.stability, (r) => m.stability < r.lt);
  if (stab) {
    out.push({ metric: 'stability', value: m.stability, threshold: stab.lt, steps: stab.steps,
      text: `Stability ${Math.round(m.stability)} is below ${stab.lt}` });
  }
  return out;
}

/** Demote a tier by `steps`, never below TEXT (only loss of connectivity reaches CACHED). */
function demote(tier, steps) {
  if (rank(tier) <= rank('TEXT')) return tier;
  return TIERS[Math.max(rank('TEXT'), rank(tier) - steps)];
}

/**
 * The tier these metrics support *right now*, ignoring hysteresis.
 * @param {Partial<Metrics>} metrics
 * @param {typeof DEFAULT_CONFIG} [config]
 * @param {{ currentTier?: string|null, scale?: number }} [ctx]
 */
export function computeInstantTier(metrics, config = DEFAULT_CONFIG, ctx = {}) {
  const m = normalizeMetrics(metrics);
  if (isOffline(m)) {
    return {
      tier: 'CACHED',
      bandwidthTier: 'CACHED',
      impairments: [],
      worst: null,
      reason: 'No connectivity → showing cached Last verified alert (new data cannot arrive)',
      factors: { offline: true, bandwidth: { value: m.bandwidthKbps, tier: 'CACHED', thresholds: config.thresholds.bandwidth }, impairments: [] },
    };
  }

  const bandwidthTier = computeBandwidthTier(m.bandwidthKbps, config, ctx);
  const impairments = collectImpairments(m, config);
  const worst = impairments.reduce((a, b) => (b.steps > (a?.steps ?? 0) ? b : a), null);
  const tier = worst ? demote(bandwidthTier, worst.steps) : bandwidthTier;

  let reason = bandwidthReason(m.bandwidthKbps, bandwidthTier, config);
  if (worst && tier !== bandwidthTier) {
    reason = `${worst.text} → demoted ${bandwidthTier} → ${tier}`;
  } else if (worst) {
    reason = `${reason} (${worst.text}, already at floor)`;
  }

  return {
    tier,
    bandwidthTier,
    impairments,
    worst,
    reason,
    factors: {
      offline: false,
      bandwidth: { value: m.bandwidthKbps, tier: bandwidthTier, thresholds: config.thresholds.bandwidth },
      impairments,
    },
  };
}

/**
 * What can be sent to a receiver at a tier, and how a priority is treated.
 * Priority beats media: CRITICAL is never dropped, and always travels as TEXT first.
 * "neverDropped" means the engine will never discard it; while offline it is queued for
 * retry / simulated SMS fallback — it is not claimed to arrive over a dead link.
 */
export function planDelivery(tier, priority = 'NORMAL', config = DEFAULT_CONFIG) {
  const r = rank(tier);
  const prio = PRIORITIES.includes(priority) ? priority : 'NORMAL';
  const critical = prio === 'CRITICAL';
  const deferLow = prio === 'LOW' && r <= rank(config.priority.deferLowAtOrBelow);

  if (tier === 'CACHED') {
    return {
      channels: [],
      primary: null,
      audio: false,
      cached: true,
      queued: !deferLow,
      deferred: deferLow,
      neverDropped: critical,
      fallbacks: prio === 'CRITICAL' || prio === 'HIGH' ? ['SMS_SIMULATED'] : [],
      note: critical
        ? 'Offline: CRITICAL alert queued for retry and simulated SMS fallback; the receiver shows its cached Last verified alert.'
        : 'Offline: delivery queued; the receiver shows its cached Last verified alert.',
    };
  }

  const channels = r === rank('TEXT') ? ['TEXT'] : r === rank('AUDIO') ? ['TEXT', 'AUDIO'] : ['TEXT', 'AUDIO', 'VIDEO'];
  return {
    channels,
    primary: 'TEXT',
    audio: channels.includes('AUDIO'),
    cached: false,
    queued: false,
    deferred: deferLow,
    neverDropped: critical,
    fallbacks: [],
    note: deferLow
      ? 'LOW priority deferred until the link recovers.'
      : critical
        ? `CRITICAL alert delivered as TEXT${channels.includes('AUDIO') ? ' + AUDIO' : ''} first; video is sacrificed before the alert.`
        : `Delivered via ${channels.join(' + ')}.`,
  };
}

/**
 * Run one engine step for one receiver.
 *
 * Hysteresis rules:
 *  - First sample adopts the instant tier (not a transition).
 *  - Downgrades need `downConfirm` consecutive worse samples, except: loss of
 *    connectivity, drops of `immediateDropSteps`+ tiers, and CRITICAL priority react at once.
 *  - Upgrades climb ONE tier at a time, need `upConfirm` consecutive better samples and
 *    `upMargin` headroom over the target tier's floor, and are blocked for `preemptHold`
 *    samples after a pre-emptive downgrade.
 *
 * @param {Partial<Metrics>} metrics
 * @param {string} [priority]
 * @param {EngineState} [state]
 * @param {typeof DEFAULT_CONFIG} [config]
 * @returns {{ decision: object, state: EngineState }}
 */
export function decide(metrics, priority = 'NORMAL', state = createEngineState(), config = DEFAULT_CONFIG) {
  const prio = PRIORITIES.includes(priority) ? priority : 'NORMAL';
  const m = normalizeMetrics(metrics);
  const cur = state.tier;
  const hyst = config.hysteresis;
  const inst = computeInstantTier(m, config, { currentTier: cur });
  const raw = inst.tier;
  const holdBefore = state.preemptHold ?? 0;

  const next = { ...state, preemptHold: Math.max(0, holdBefore - 1) };
  const resetPending = () => {
    next.pendingDirection = null;
    next.pendingCount = 0;
  };

  let tier = raw;
  let changed = false;
  let held = false;
  let initial = false;
  let reason = inst.reason;
  let confirm = 0;

  if (cur == null) {
    initial = true;
    resetPending();
  } else if (raw === cur) {
    resetPending();
  } else if (rank(raw) < rank(cur)) {
    const steps = rank(cur) - rank(raw);
    const bypass = raw === 'CACHED' ? 'offline' : steps >= hyst.immediateDropSteps ? 'severe' : prio === 'CRITICAL' ? 'critical' : null;
    confirm = bypass ? 1 : hyst.downConfirm;
    const count = state.pendingDirection === 'DOWN' ? state.pendingCount + 1 : 1;
    if (count >= confirm) {
      changed = true;
      resetPending();
      if (bypass === 'critical') reason += ' (CRITICAL priority: no debounce)';
      if (bypass === 'severe') reason += ' (severe drop: no debounce)';
    } else {
      tier = cur;
      held = true;
      next.pendingDirection = 'DOWN';
      next.pendingCount = count;
      reason = `Holding ${cur}: ${inst.reason} — confirming ${count}/${confirm}`;
    }
  } else if (holdBefore > 0) {
    tier = cur;
    held = true;
    resetPending();
    reason = `Holding ${cur}: pre-emptive downgrade active (${holdBefore} samples left)`;
  } else {
    const cand = computeInstantTier(m, config, { currentTier: cur, scale: hyst.upMargin });
    if (rank(cand.tier) <= rank(cur)) {
      tier = cur;
      held = true;
      resetPending();
      reason = `Holding ${cur}: ${raw} conditions lack the ${Math.round((hyst.upMargin - 1) * 100)}% headroom needed to upgrade`;
    } else {
      confirm = cur === 'CACHED' ? hyst.reconnectConfirm : hyst.upConfirm;
      const count = state.pendingDirection === 'UP' ? state.pendingCount + 1 : 1;
      if (count >= confirm) {
        tier = TIERS[rank(cur) + 1];
        changed = true;
        resetPending();
        reason = `Recovered: ${cand.reason}, stable for ${count} samples → upgraded ${cur} → ${tier}`;
      } else {
        tier = cur;
        held = true;
        next.pendingDirection = 'UP';
        next.pendingCount = count;
        reason = `Holding ${cur}: conditions support ${cand.tier} — confirming ${count}/${confirm}`;
      }
    }
  }

  next.tier = tier;

  const decision = {
    tier,
    mode: TIER_MODE[tier],
    from: initial ? null : cur,
    changed,
    initial,
    held,
    rawTier: raw,
    trigger: changed ? 'REACTIVE' : null,
    reason,
    factors: inst.factors,
    metrics: m,
    priority: prio,
    delivery: planDelivery(tier, prio, config),
    hysteresis: { direction: next.pendingDirection, count: next.pendingCount, needed: confirm },
  };
  return { decision, state: next };
}

/**
 * Perform a pre-emptive (predictive) one-step downgrade recommended by the predictor.
 * Returns null when the prediction is not actionable.
 * @returns {{ decision: object, state: EngineState }|null}
 */
export function applyPreemptive(state, prediction, metrics, priority = 'NORMAL', config = DEFAULT_CONFIG) {
  if (!prediction?.recommend || state.tier == null) return null;
  const cur = state.tier;
  const to = prediction.recommendedTier;
  if (!to || rank(to) >= rank(cur) || rank(to) < rank('TEXT')) return null;

  const prio = PRIORITIES.includes(priority) ? priority : 'NORMAL';
  const m = normalizeMetrics(metrics);
  const next = { ...state, tier: to, pendingDirection: null, pendingCount: 0, preemptHold: config.hysteresis.preemptHold };
  const decision = {
    tier: to,
    mode: TIER_MODE[to],
    from: cur,
    changed: true,
    initial: false,
    held: false,
    rawTier: to,
    trigger: 'PREDICTIVE',
    reason: `${prediction.message} — ${prediction.detail}`,
    factors: {
      offline: false,
      bandwidth: { value: m.bandwidthKbps, tier: cur, thresholds: config.thresholds.bandwidth },
      impairments: [],
      prediction: {
        horizonSec: prediction.horizonSec,
        confidence: prediction.confidence,
        predictedTier: prediction.predictedTier,
        trend: prediction.trend,
      },
    },
    metrics: m,
    priority: prio,
    delivery: planDelivery(to, prio, config),
    hysteresis: { direction: null, count: 0, needed: 0 },
  };
  return { decision, state: next };
}

/**
 * Turn a changed decision into a persistable quality event. Returns null when nothing changed.
 * `meta.at` is supplied by the caller so this stays pure.
 */
export function buildQualityEvent(decision, meta = {}) {
  if (!decision?.changed) return null;
  return {
    from: decision.from,
    to: decision.tier,
    fromMode: TIER_MODE[decision.from],
    toMode: decision.mode,
    direction: rank(decision.tier) < rank(decision.from) ? 'DOWN' : 'UP',
    trigger: decision.trigger,
    reason: decision.reason,
    priority: decision.priority,
    metrics: decision.metrics,
    factors: decision.factors ?? null,
    at: meta.at ?? null,
    receiverId: meta.receiverId ?? null,
    broadcastId: meta.broadcastId ?? null,
  };
}
