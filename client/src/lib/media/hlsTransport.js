import { createEmitter } from './emitter.js';
import { levelIndexForLayer } from './layers.js';

/**
 * HLS viewer. hls.js is loaded on demand and its adaptive bitrate is turned OFF: the level is whatever the
 * server-side engine says (`setLayer`). hls.js is only the decoder/loader here.
 * `deps.loadHls` is injectable for tests.
 */
export function createHlsTransport({ playlistUrl, video, deps = {} }) {
  const ev = createEmitter();
  let hls = null;
  let wantLayer = null;
  let state = { status: 'connecting', provider: 'hls', simulated: false, layer: null, bitrateKbps: 0, buffering: false, delayedSec: 0, error: null };
  const set = (p) => { state = { ...state, ...p }; ev.emit('state', state); };

  const apply = () => {
    if (!hls) return;
    if (wantLayer == null) {
      hls.stopLoad();
      video?.pause?.();
      set({ layer: null, bitrateKbps: 0 });
      return;
    }
    hls.startLoad(-1);
    const idx = levelIndexForLayer(hls.levels ?? [], wantLayer);
    if (idx >= 0) {
      hls.currentLevel = idx; // manual level: disables hls.js ABR
      const lvl = hls.levels[idx];
      set({ layer: wantLayer, bitrateKbps: Math.round((lvl.bitrate ?? 0) / 1000) });
      video?.play?.().catch(() => {});
    }
  };

  return {
    provider: 'hls',
    simulated: false,
    state: () => state,
    on: ev.on,
    connect() {
      return new Promise((resolve, reject) => {
        (async () => {
          const Hls = deps.loadHls ? await deps.loadHls() : (await import('hls.js')).default;
          if (!Hls.isSupported()) {
            if (video?.canPlayType?.('application/vnd.apple.mpegurl')) { video.src = playlistUrl; set({ status: 'live' }); return resolve(); } // Safari: native HLS (its own ABR; cannot be pinned)
            throw new Error('HLS is not supported in this browser');
          }
          hls = new Hls({ enableWorker: true, lowLatencyMode: false, startLevel: -1, capLevelToPlayerSize: false, maxBufferLength: 10 });
          let settled = false;
          hls.on(Hls.Events.MANIFEST_PARSED, () => { apply(); });
          hls.on(Hls.Events.FRAG_LOADED, () => {
            if (!settled) { settled = true; set({ status: 'live', buffering: false }); resolve(); }
          });
          hls.on(Hls.Events.FRAG_BUFFERED, () => set({ buffering: false, delayedSec: Math.max(0, Math.round((hls.liveSyncPosition ?? 0) - (video?.currentTime ?? 0))) }));
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return set({ buffering: true });
            const err = new Error(`HLS error: ${data.details ?? data.type}`);
            set({ status: 'failed', error: err.message });
            if (!settled) { settled = true; reject(err); }
          });
          hls.loadSource(playlistUrl);
          hls.attachMedia(video);
        })().catch((e) => { set({ status: 'failed', error: e.message }); reject(e); });
      });
    },
    setLayer(layer) { wantLayer = layer; apply(); },
    getStats: () => null, // HLS segment timings are not link stats; only WebRTC feeds the engine
    destroy() { try { hls?.destroy(); } catch { /* ignore */ } ev.clear(); },
  };
}
