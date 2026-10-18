import { describe, expect, it } from 'vitest';
import { LAYER_ORDER, MEDIA_LAYERS, TIERS, layerForTier, layerKbps, normalizeProviderChain, pickLayer, tierForLayer } from '../src/index.js';

describe('tier ↔ media layer mapping', () => {
  it('video tiers map to their own layer, with video and audio', () => {
    for (const t of ['720p', '480p', '240p']) {
      expect(layerForTier(t)).toBe(t);
      expect(MEDIA_LAYERS[t].video).toBe(true);
      expect(tierForLayer(t)).toBe(t);
    }
  });
  it('AUDIO is audio-only; TEXT and CACHED carry no media', () => {
    expect(MEDIA_LAYERS.AUDIO).toMatchObject({ video: false, audio: true });
    expect(layerForTier('AUDIO')).toBe('AUDIO');
    expect(layerForTier('TEXT')).toBeNull();
    expect(layerForTier('CACHED')).toBeNull();
  });
  it('every engine tier is either a layer or text-only (no gaps)', () => {
    for (const t of TIERS) expect(layerForTier(t) === null ? ['TEXT', 'CACHED'].includes(t) : true).toBe(true);
  });
  it('layers get strictly cheaper going down', () => {
    const k = LAYER_ORDER.map(layerKbps);
    for (let i = 1; i < k.length; i++) expect(k[i]).toBeLessThan(k[i - 1]);
  });
  it('pickLayer never exceeds the tier and respects what the provider offers', () => {
    expect(pickLayer('720p')).toBe('720p');
    expect(pickLayer('480p', ['720p', '240p'])).toBe('240p');
    expect(pickLayer('240p', ['720p', '480p'])).toBeNull();
    expect(pickLayer('AUDIO', LAYER_ORDER)).toBe('AUDIO');
    expect(pickLayer('TEXT')).toBeNull();
    expect(pickLayer('CACHED')).toBeNull();
    expect(pickLayer('bogus')).toBeNull();
  });
  it('the provider chain always ends in simulated and drops unknown names', () => {
    expect(normalizeProviderChain(['livekit', 'hls'])).toEqual(['livekit', 'hls', 'simulated']);
    expect(normalizeProviderChain(['simulated', 'livekit'])).toEqual(['livekit', 'simulated']);
    expect(normalizeProviderChain(['x', 'HLS', 'hls'])).toEqual(['hls', 'simulated']);
    expect(normalizeProviderChain([])).toEqual(['simulated']);
  });
});
