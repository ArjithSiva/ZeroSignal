/**
 * Receiver controller: everything a receiving device does, independent of React.
 *
 *   • joins a broadcast over Socket.IO and re-joins automatically after a reconnect;
 *   • produces network metrics once per tick — SIMULATED (preset / slider / scripted curve / chaos /
 *     offline) or MEASURED (Live Mode) — and reports them so the SERVER runs the adaptive engine;
 *   • receives alerts (direct, or via the simulated SMS / mesh channels), verifies the Ed25519
 *     signature, caches verified CRITICAL alerts, acknowledges delivery and raises a takeover.
 *
 * React reads it through `subscribe` / `getSnapshot` (useSyncExternalStore).
 * Collaborators are injectable so the controller is unit-testable with a fake socket.
 */
import { PRESETS, applyChaos, applyNoise, createRng, metricsFromSlider, sampleCurve, SCENARIOS, degradingCurve } from '@zerosignal/shared';
import { emitAck } from './socket.js';
import * as alertCache from './alertCache.js';
import { measureLive } from './liveProbe.js';

const MAX_ALERTS = 30;
const MAX_EVENTS = 40;
const MAX_FEED = 30;
const MAX_HISTORY = 90;

/** Headline / action / body to DISPLAY, taken from the signed payload so what is shown is what was verified. */
export function alertText(alert, language = 'en') {
  const order = [language, 'en', ...Object.keys(alert.signed ?? {})];
  for (const lang of order) {
    const p = alert.signed?.[lang]?.payload;
    if (p?.h) {
      const full = alert.translations?.[lang];
      return { language: lang, headline: p.h, action: p.a ?? full?.action ?? '', body: full?.text ?? p.b ?? '' };
    }
  }
  const t = alert.translations?.[language] ?? alert.translations?.en;
  return { language, headline: t?.summary ?? 'Emergency alert', action: t?.action ?? '', body: t?.text ?? '' };
}

/**
 * @param {object} opts
 * @param {import('socket.io-client').Socket} opts.socket
 * @param {string} opts.broadcastId
 * @param {string} opts.id          receiver id (unique per user)
 * @param {string} [opts.name]
 * @param {{lat:number,lng:number}} [opts.location]
 * @param {string} [opts.language]
 * @param {boolean} [opts.autoPreempt]
 * @param {number} [opts.tickMs]
 * @param {number} [opts.seed]
 * @param {() => number} [opts.now]
 * @param {object} [opts.deps]      overrides for { cache, measure, emitAck }
 */
export function createReceiverClient(opts) {
  const { socket, broadcastId, id, name = id, location, tickMs = 1000, seed = 7, now = Date.now } = opts;
  const cache = opts.deps?.cache ?? alertCache;
  const measure = opts.deps?.measure ?? measureLive;
  const ask = opts.deps?.emitAck ?? emitAck;
  const rng = createRng(seed);

  let language = opts.language ?? 'en';
  let autoPreempt = opts.autoPreempt ?? true;
  let timer = null;
  let disposed = false;
  let probing = false;
  let curve = null;
  let curveStart = 0;
  let fixed = null;
  const listeners = new Set();
  const handlers = [];

  // control state (what the simulator is doing)
  let measuredFn = null;
  const ctl = { source: 'preset', preset: 'EXCELLENT', slider: 100, noise: true, chaos: false, live: false, offline: false, curveName: null };

  /** @type {Record<string, any>} */
  let snap = {
    status: 'idle', // idle | connecting | joined | reconnecting | error | ended
    error: null,
    id,
    name,
    language,
    autoPreempt,
    broadcast: null,
    receiver: null,
    metrics: null,
    simulated: true,
    metricSource: 'simulated',
    control: { ...ctl },
    history: [],
    tierSeconds: {},
    alerts: [],
    takeover: null,
    cached: null,
    events: [],
    feed: [], // simulated SMS / mesh log
    responded: {},
    serverOffsetMs: 0,
  };

  const emit = () => listeners.forEach((l) => l());
  const set = (patch) => {
    snap = { ...snap, ...(typeof patch === 'function' ? patch(snap) : patch) };
    emit();
  };
  const on = (event, fn) => {
    socket.on(event, fn);
    handlers.push([event, fn]);
  };

  // ───────────────────────── alerts ─────────────────────────
  async function loadCached() {
    try {
      set({ cached: await cache.readLastVerified(broadcastId) });
    } catch {
      /* IndexedDB unavailable — the UI simply shows no cached alert */
    }
  }

  async function handleAlert({ alert, channel = 'TEXT+MEDIA', simulated = false, via = null, bytes = 0 }) {
    if (!alert?.id) return;
    const entry = { ...alert, channel, simulated, via, bytes, receivedAt: now(), verification: 'pending', superseded: false, acknowledged: false };
    set((s) => ({ alerts: [entry, ...s.alerts.filter((a) => a.id !== alert.id)].slice(0, MAX_ALERTS) }));

    const status = await cache.verifyAlertLanguages(alert.signed);
    const values = Object.values(status);
    const verification = !values.length ? 'unverified' : values.some((v) => v === 'rejected') ? 'rejected' : values.every((v) => v === 'verified') ? 'verified' : 'unverified';
    const patchAlert = (patch) => set((s) => ({ alerts: s.alerts.map((a) => (a.id === alert.id ? { ...a, ...patch } : a)) }));
    patchAlert({ verification, languageStatus: status });

    if (verification === 'rejected') return; // a forged alert is shown as rejected; it never takes over the screen or gets cached

    if (alert.priority === 'CRITICAL' && verification === 'verified') {
      try {
        await cache.saveCriticalAlert(broadcastId, alert);
        await loadCached();
      } catch {
        /* cache is best-effort */
      }
    }
    if (alert.priority === 'CRITICAL' || alert.priority === 'HIGH') {
      set((s) => (s.alerts.find((a) => a.id === alert.id)?.superseded ? {} : { takeover: { ...s.alerts.find((a) => a.id === alert.id), verification } }));
    }
    try {
      await ask(socket, 'alert:ack', { receiverId: id, messageId: alert.id });
      patchAlert({ acknowledged: true });
    } catch {
      /* the server retries CRITICAL delivery until acked or expired */
    }
  }

  // ───────────────────────── socket events ─────────────────────────
  on('alert:received', (p) => handleAlert(p));
  on('sms:simulated', (p) => {
    set((s) => ({ feed: [{ kind: 'SMS', at: now(), bytes: p.bytes, messageId: p.alert?.id, simulated: true }, ...s.feed].slice(0, MAX_FEED) }));
    return handleAlert({ ...p, channel: 'SMS_SIMULATED', simulated: true });
  });
  on('mesh:relay', (p) => set((s) => ({ feed: [{ kind: 'MESH', at: now(), from: p.from, to: p.to, messageId: p.messageId, direction: p.to === id ? 'received' : 'relayed', simulated: true }, ...s.feed].slice(0, MAX_FEED) })));
  on('alert:superseded', ({ oldId, newId }) =>
    set((s) => ({
      alerts: s.alerts.map((a) => (a.id === oldId ? { ...a, superseded: true, supersededBy: newId } : a)),
      takeover: s.takeover?.id === oldId ? null : s.takeover,
    })),
  );
  on('receiver:state', (view) => {
    if (view.id !== id) return;
    set((s) => ({
      receiver: view,
      metrics: view.metrics ?? s.metrics,
      history: view.metrics ? [...s.history, { t: now(), bandwidthKbps: view.metrics.bandwidthKbps, tier: view.tier, health: view.health?.score ?? null }].slice(-MAX_HISTORY) : s.history,
    }));
    if (view.tier === 'CACHED') loadCached();
  });
  on('quality:changed', (e) => {
    if (e.receiverId && e.receiverId !== id) return;
    set((s) => ({ events: [e, ...s.events].slice(0, MAX_EVENTS) }));
  });
  on('broadcast:stop', () => set({ status: 'ended' }));
  on('broadcast:start', (b) => set((s) => ({ broadcast: { ...(s.broadcast ?? {}), ...b } })));
  on('network:control', ({ command }) => applyCommand(command));
  on('connect', () => {
    if (snap.status === 'reconnecting' || snap.status === 'connecting') join().catch(() => {});
  });
  on('disconnect', () => {
    if (!disposed && snap.status !== 'ended') set({ status: 'reconnecting' });
  });
  on('connect_error', (e) => {
    if (e?.message === 'UNAUTHORIZED') set({ status: 'error', error: 'Your session expired. Sign in again.' });
  });

  // ───────────────────────── simulator control ─────────────────────────
  function syncControl() {
    set({ control: { ...ctl } });
  }

  function applyCommand(c = {}) {
    if (c.preset) setPreset(c.preset);
    if (typeof c.slider === 'number') setSlider(c.slider);
    if (c.scenario === 'degrading') playCurve(null);
    if (c.scenario === 'chaos') setChaos(true);
    if (c.scenario === 'stop') {
      curve = null;
      ctl.curveName = null;
      ctl.chaos = false;
      ctl.source = 'preset';
      syncControl();
    }
  }
  /** Pin the simulator to explicit metrics (used by the Demo page for the spec's A/B/C conditions). */
  function setFixed(metrics) {
    curve = null;
    fixed = { online: true, ...metrics };
    Object.assign(ctl, { source: 'fixed', curveName: null, live: false, offline: false });
    syncControl();
  }
  function setPreset(name) {
    if (!PRESETS[name]) return;
    curve = null;
    Object.assign(ctl, { source: 'preset', preset: name, curveName: null, live: false, offline: name === 'OFFLINE' });
    syncControl();
  }
  function setSlider(v) {
    curve = null;
    Object.assign(ctl, { source: 'slider', slider: v, curveName: null, live: false, offline: false });
    syncControl();
  }
  /** Play a scripted scenario curve for this receiver (or the generic degrading curve when `scenarioId` is null). */
  function playCurve(scenarioId) {
    const sc = scenarioId ? SCENARIOS[scenarioId] : null;
    curve = sc ? (sc.curves[id] ?? sc.curves.A) : degradingCurve(120);
    curveStart = now();
    Object.assign(ctl, { source: 'curve', curveName: scenarioId ?? 'degrading', live: false, offline: false });
    syncControl();
  }
  function setChaos(on) {
    ctl.chaos = Boolean(on);
    syncControl();
  }
  function setOffline(on) {
    ctl.offline = Boolean(on);
    if (on) ctl.live = false;
    syncControl();
  }
  /** Feed real receive stats (from a media transport) into the engine. Pass null to go back to simulation/probe. */
  function setMeasuredSource(fn) {
    measuredFn = typeof fn === 'function' ? fn : null;
    // Real stats take over the engine's input until someone picks a simulation control (which sets its own source).
    if (measuredFn) ctl.source = 'measured';
    else if (ctl.source === 'measured') ctl.source = 'preset';
    syncControl();
  }
  function setLive(on) {
    ctl.live = Boolean(on);
    if (on) {
      curve = null;
      ctl.offline = false;
      ctl.chaos = false;
      ctl.source = 'live';
    } else if (ctl.source === 'live') ctl.source = 'preset';
    syncControl();
  }

  function simulatedMetrics() {
    let base;
    if (ctl.offline) return { ...PRESETS.OFFLINE };
    if (curve) base = sampleCurve(curve, (now() - curveStart) / 1000);
    else if (ctl.source === 'fixed' && fixed) base = { ...fixed };
    else if (ctl.source === 'slider') base = metricsFromSlider(ctl.slider);
    else base = { ...PRESETS[ctl.preset] };
    if (!base.online) return base;
    // pinned demo conditions wobble less so each receiver stays on its intended tier
    let m = ctl.noise ? applyNoise(base, rng, ctl.source === 'fixed' ? 0.3 : 1) : base;
    if (ctl.chaos) m = applyChaos(m, rng, 0.6);
    return m;
  }

  // ───────────────────────── lifecycle ─────────────────────────
  async function join() {
    set({ status: snap.status === 'reconnecting' ? 'reconnecting' : 'connecting', error: null });
    try {
      const res = await ask(socket, 'receiver:join', { broadcastId, receiverId: id, name, language, location, autoPreempt });
      set({ status: 'joined', receiver: res.receiver, broadcast: res.broadcast, serverOffsetMs: (res.serverTime ?? now()) - now() });
      loadCached();
      return res;
    } catch (e) {
      set({ status: 'error', error: e.message });
      throw e;
    }
  }

  async function tick() {
    if (disposed || snap.status !== 'joined' || !socket.connected || probing) return;
    let metrics;
    let simulated = true;
    let source = 'simulated';
    const real = ctl.source === 'measured' && !ctl.offline && !ctl.chaos && measuredFn ? measuredFn() : null;
    if (real) {
      // Real WebRTC receive stats from the media transport: genuine, so the engine runs on them.
      metrics = real;
      simulated = false;
      source = 'measured';
    } else if (ctl.live && !ctl.offline) {
      probing = true;
      try {
        metrics = await measure();
        simulated = false;
        source = 'probe';
      } finally {
        probing = false;
      }
    } else metrics = simulatedMetrics();
    set((s) => ({ simulated, metricSource: source, metrics, tierSeconds: s.receiver?.tier ? { ...s.tierSeconds, [s.receiver.tier]: (s.tierSeconds[s.receiver.tier] ?? 0) + tickMs / 1000 } : s.tierSeconds }));
    try {
      await ask(socket, 'network:update', { receiverId: id, metrics, simulated, source }, 4000);
    } catch {
      /* dropped by flood protection or a transient failure — the next tick reports again */
    }
  }

  function start() {
    if (timer || disposed) return;
    timer = setInterval(() => tick(), tickMs);
    if (socket.connected) join().catch(() => {});
    else {
      set({ status: 'connecting' });
      if (typeof socket.connect === 'function') socket.connect();
    }
  }

  async function leave() {
    clearInterval(timer);
    timer = null;
    try {
      await ask(socket, 'receiver:leave', { receiverId: id }, 2000);
    } catch {
      /* server grace timer cleans up */
    }
  }

  function dispose() {
    disposed = true;
    clearInterval(timer);
    timer = null;
    for (const [e, fn] of handlers) socket.off(e, fn);
    listeners.clear();
  }

  async function setLanguage(next) {
    language = next;
    set({ language });
    try {
      await ask(socket, 'receiver:update', { receiverId: id, language });
    } catch {
      /* not joined yet */
    }
  }
  async function setAutoPreempt(on) {
    autoPreempt = on;
    set({ autoPreempt });
    try {
      await ask(socket, 'receiver:update', { receiverId: id, autoPreempt: on });
    } catch {
      /* not joined yet */
    }
  }

  /** "I'm safe" / "Need help" — works over any tier because it is a tiny message. */
  async function respond(messageId, status) {
    await ask(socket, 'alert:response', { receiverId: id, messageId, status, ...(location ? { location } : {}) });
    set((s) => ({ responded: { ...s.responded, [messageId]: status } }));
  }

  return {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snap,
    start,
    tick,
    join,
    leave,
    dispose,
    setPreset,
    setSlider,
    setFixed,
    playCurve,
    setChaos,
    setOffline,
    setLive,
    setMeasuredSource,
    setLanguage,
    setAutoPreempt,
    respond,
    dismissTakeover: () => set({ takeover: null }),
    loadCached,
    /** DEMO: corrupt the cache, then re-read it to show the signature check rejecting it. */
    async tamperCache() {
      await cache.tamperCachedAlert(broadcastId);
      await loadCached();
    },
  };
}
