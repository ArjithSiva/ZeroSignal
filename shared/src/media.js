/**
 * Media layers: how an adaptive-engine tier maps onto what a real stream can carry.
 *
 * The engine is the single authority on which tier a receiver gets. The media layer never picks its own
 * quality (no player ABR): the server tells each receiver which layer to subscribe to, and the player
 * only follows. Alerts never depend on media: TEXT and CACHED carry no stream at all.
 */
import { TIER_RANK } from './config.js';

/** Real-world encoding ladder (approximate, used for ingest settings and HLS variants). */
export const MEDIA_LAYERS = Object.freeze({
  '720p': Object.freeze({ id: '720p', video: true, audio: true, width: 1280, height: 720, fps: 30, videoKbps: 1800, audioKbps: 96 }),
  '480p': Object.freeze({ id: '480p', video: true, audio: true, width: 854, height: 480, fps: 24, videoKbps: 800, audioKbps: 64 }),
  '240p': Object.freeze({ id: '240p', video: true, audio: true, width: 426, height: 240, fps: 15, videoKbps: 250, audioKbps: 48 }),
  AUDIO: Object.freeze({ id: 'AUDIO', video: false, audio: true, width: 0, height: 0, fps: 0, videoKbps: 0, audioKbps: 32 }),
});

/** Layers best → worst. */
export const LAYER_ORDER = Object.freeze(['720p', '480p', '240p', 'AUDIO']);

/** Tiers that carry no media at all: the signed text alert (or the cached one) is the whole experience. */
export const NO_MEDIA_TIERS = Object.freeze(['TEXT', 'CACHED']);

/** Engine tier → media layer id, or null when the tier is text-only. */
export function layerForTier(tier) {
  return tier in MEDIA_LAYERS ? tier : null;
}

/** Media layer id → the engine tier it corresponds to. */
export const tierForLayer = (layer) => (layer in MEDIA_LAYERS ? layer : null);

/**
 * Highest layer that is not above `tier` and that the provider actually offers.
 * e.g. tier 480p with only ['720p','240p'] → '240p'. Returns null when nothing fits (text-only).
 */
export function pickLayer(tier, available = LAYER_ORDER) {
  const rank = TIER_RANK[tier];
  if (rank == null) return null;
  const best = LAYER_ORDER.filter((l) => available.includes(l) && TIER_RANK[l] <= rank);
  return best[0] ?? null;
}

/** Combined bitrate of a layer, kbps. */
export const layerKbps = (layer) => (MEDIA_LAYERS[layer] ? MEDIA_LAYERS[layer].videoKbps + MEDIA_LAYERS[layer].audioKbps : 0);

/** Provider ids in fallback order; `simulated` is always the last resort, and never dropped. */
export function normalizeProviderChain(list = []) {
  const known = ['livekit', 'hls', 'simulated'];
  const out = [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter((s) => known.includes(s)))];
  return out.includes('simulated') ? [...out.filter((p) => p !== 'simulated'), 'simulated'] : [...out, 'simulated'];
}

/** Honest provenance of a network reading that feeds the engine. */
export const METRIC_SOURCES = Object.freeze(['measured', 'probe', 'simulated']);
export const METRIC_SOURCE_LABEL = Object.freeze({
  measured: 'Measured (real WebRTC stats)',
  probe: 'Probe-estimated (HTTP probe)',
  simulated: 'Simulated',
});
