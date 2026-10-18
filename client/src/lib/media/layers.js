import { MEDIA_LAYERS } from '@zerosignal/shared';

/**
 * Pick the hls.js level index for a server-chosen layer. hls.js sorts levels by bitrate, so we match on
 * resolution, not position. AUDIO = the level with no video; a missing video layer falls back to the
 * best level that is not above it. Returns -1 when nothing fits.
 * @param {{height?: number, width?: number, videoCodec?: string}[]} levels
 */
export function levelIndexForLayer(levels, layer) {
  if (!layer || !MEDIA_LAYERS[layer]) return -1;
  const isAudio = (l) => !l.height && !l.width;
  if (layer === 'AUDIO') return levels.findIndex(isAudio);
  const want = MEDIA_LAYERS[layer].height;
  let best = -1;
  levels.forEach((l, i) => {
    if (isAudio(l) || l.height > want) return;
    if (best === -1 || l.height > levels[best].height) best = i;
  });
  return best;
}

/** LiveKit simulcast quality names for a layer (null = unsubscribe video: audio-only or text-only). */
export function livekitQuality(layer) {
  return { '720p': 'HIGH', '480p': 'MEDIUM', '240p': 'LOW' }[layer] ?? null;
}
