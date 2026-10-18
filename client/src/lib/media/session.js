import { createEmitter } from './emitter.js';

/**
 * A media session walks a provider chain (e.g. livekit → hls → simulated) and degrades down it:
 *   • a provider that fails to connect within `connectTimeoutMs` is skipped;
 *   • a provider that later reports `failed`, or sits in waiting/buffering for `stallMs`, is replaced by the
 *     next one;
 *   • `simulated` is always last and cannot fail, so there is always something truthful on screen.
 * Alerts never depend on this: it only drives the picture.
 *
 * @param {{ chain: {provider: string}[], create: (entry) => any, connectTimeoutMs?: number, stallMs?: number, setTimer?: Function, clearTimer?: Function }} opts
 */
export function createMediaSession({ chain, create, connectTimeoutMs = 8000, stallMs = 12000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const ev = createEmitter();
  const failures = [];
  let idx = -1;
  let active = null;
  let layer = '720p';
  let stallTimer = null;
  let unsub = null;
  let destroyed = false;
  let moving = false;

  const snapshot = () => ({ provider: active?.provider ?? null, simulated: Boolean(active?.simulated), failures: [...failures], transport: active, state: active?.state?.() ?? null });
  const emit = () => ev.emit('change', snapshot());

  const clearStall = () => { if (stallTimer) clearTimer(stallTimer); stallTimer = null; };
  const teardown = () => { clearStall(); unsub?.(); unsub = null; active?.destroy?.(); active = null; };

  const withTimeout = (p, ms) => new Promise((res, rej) => {
    const t = setTimer(() => rej(new Error('timed out connecting')), ms);
    p.then((v) => { clearTimer(t); res(v); }, (e) => { clearTimer(t); rej(e); });
  });

  async function advance(reason) {
    if (destroyed || moving) return;
    moving = true;
    if (active && reason) failures.push({ provider: active.provider, reason });
    teardown();
    while (!destroyed && ++idx < chain.length) {
      const entry = chain[idx];
      let t;
      try {
        t = create(entry);
        if (!t) throw new Error('provider unavailable');
        const last = entry.provider === 'simulated';
        await (last ? t.connect() : withTimeout(t.connect(), connectTimeoutMs));
        if (destroyed) { t.destroy?.(); break; }
        active = t;
        t.setLayer(layer);
        unsub = t.on('state', (s) => {
          if (destroyed || t !== active) return;
          if (s.status === 'failed' && entry.provider !== 'simulated') return void advance(s.error ?? 'failed');
          clearStall();
          if ((s.status === 'waiting' || s.buffering) && entry.provider !== 'simulated') stallTimer = setTimer(() => advance('stalled'), stallMs);
          emit();
        });
        const s = t.state?.();
        if (s && (s.status === 'waiting' || s.buffering) && entry.provider !== 'simulated') stallTimer = setTimer(() => advance('stalled'), stallMs);
        break;
      } catch (e) {
        t?.destroy?.();
        failures.push({ provider: entry.provider, reason: e.message });
      }
    }
    moving = false;
    emit();
  }

  return {
    start: () => advance(null),
    on: ev.on,
    snapshot,
    setLayer(l) { layer = l; active?.setLayer(l); },
    getStats: () => active?.getStats?.() ?? null,
    destroy() { destroyed = true; teardown(); ev.clear(); },
  };
}
