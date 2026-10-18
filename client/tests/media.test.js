import { describe, expect, it, vi } from 'vitest';
import { LAYER_ORDER, layerForTier, TIERS } from '@zerosignal/shared';
import { levelIndexForLayer, livekitQuality } from '../src/lib/media/layers.js';
import { metricsFromStats, summarizeReport } from '../src/lib/media/stats.js';
import { createMediaSession } from '../src/lib/media/session.js';
import { createSimulatedTransport } from '../src/lib/media/simulatedTransport.js';
import { createHlsTransport } from '../src/lib/media/hlsTransport.js';
import { createLivekitTransport } from '../src/lib/media/livekitTransport.js';
import { createEmitter } from '../src/lib/media/emitter.js';

describe('tier → layer → player control', () => {
  // hls.js sorts levels by bitrate, so positions say nothing about quality
  const levels = [{ height: 240, bitrate: 300000 }, { height: 0, width: 0, bitrate: 35000 }, { height: 720, bitrate: 1900000 }, { height: 480, bitrate: 900000 }];
  it('finds the HLS level by resolution, not by position', () => {
    expect(levelIndexForLayer(levels, '720p')).toBe(2);
    expect(levelIndexForLayer(levels, '480p')).toBe(3);
    expect(levelIndexForLayer(levels, '240p')).toBe(0);
    expect(levelIndexForLayer(levels, 'AUDIO')).toBe(1);
  });
  it('falls back to the best level not above the layer; nothing for text-only', () => {
    expect(levelIndexForLayer([{ height: 240 }, { height: 720 }], '480p')).toBe(0);
    expect(levelIndexForLayer([{ height: 720 }], '240p')).toBe(-1);
    expect(levelIndexForLayer(levels, null)).toBe(-1);
  });
  it('every engine tier maps to exactly one player action', () => {
    for (const t of TIERS) {
      const layer = layerForTier(t);
      if (layer) {
        expect(LAYER_ORDER).toContain(layer);
        expect(levelIndexForLayer(levels, layer)).toBeGreaterThanOrEqual(0);
      } else expect(['TEXT', 'CACHED']).toContain(t);
    }
    expect(['720p', '480p', '240p', 'AUDIO'].map(livekitQuality)).toEqual(['HIGH', 'MEDIUM', 'LOW', null]);
  });
});

describe('WebRTC stats → engine metrics (measured)', () => {
  const report = (o) => new Map([
    ['v', { type: 'inbound-rtp', isRemote: false, bytesReceived: o.bytes, packetsReceived: o.recv, packetsLost: o.lost, jitter: o.jitter ?? 0.01 }],
    ['p', { type: 'candidate-pair', nominated: true, currentRoundTripTime: o.rtt ?? 0.05, ...(o.avail ? { availableIncomingBitrate: o.avail } : {}) }],
  ]);
  it('derives bitrate, loss, jitter and rtt from two samples', () => {
    const a = summarizeReport(report({ bytes: 0, recv: 0, lost: 0 }));
    const b = summarizeReport(report({ bytes: 250_000, recv: 900, lost: 100, jitter: 0.02, rtt: 0.12 }));
    const m = metricsFromStats(a, b, 1000);
    expect(m.receiveKbps).toBe(2000);
    expect(m.bandwidthKbps).toBe(2000);
    expect(m.packetLoss).toBe(10);
    expect(m.jitterMs).toBe(20);
    expect(m.latencyMs).toBe(120);
  });
  it("prefers the browser's own incoming-bandwidth estimate when it exists", () => {
    const a = summarizeReport(report({ bytes: 0, recv: 0, lost: 0 }));
    const b = summarizeReport(report({ bytes: 31_250, recv: 100, lost: 0, avail: 8_000_000 }));
    expect(metricsFromStats(a, b, 1000)).toMatchObject({ receiveKbps: 250, bandwidthKbps: 8000 });
  });
  it('handles empty input without NaN', () => {
    expect(metricsFromStats(null, null, 1000)).toBeNull();
    const z = summarizeReport(new Map());
    const m = metricsFromStats(z, z, 1000);
    expect(Object.values(m).every((v) => typeof v === 'boolean' || Number.isFinite(v))).toBe(true);
    expect(m.packetLoss).toBe(0);
  });
  it('a steady stream scores more stable than a bursty one', () => {
    const a = summarizeReport(report({ bytes: 0, recv: 0, lost: 0 }));
    const b = summarizeReport(report({ bytes: 100_000, recv: 100, lost: 0 }));
    expect(metricsFromStats(a, b, 1000, [800, 800, 800, 800]).stability).toBeGreaterThan(metricsFromStats(a, b, 1000, [50, 2000, 40, 1800]).stability);
  });
});

/** A scriptable fake transport. */
function fake(provider, { connect = 'ok', simulated = false } = {}) {
  const ev = createEmitter();
  let state = { status: connect === 'waiting' ? 'waiting' : 'live', provider, simulated, layer: null, buffering: false };
  const t = {
    provider,
    simulated,
    layers: [],
    destroyed: false,
    state: () => state,
    on: ev.on,
    connect: vi.fn(async () => {
      if (connect === 'fail') throw new Error('boom');
      if (connect === 'hang') await new Promise(() => {});
    }),
    setLayer: vi.fn((l) => { t.layers.push(l); }),
    getStats: () => null,
    destroy: () => { t.destroyed = true; },
    push: (p) => { state = { ...state, ...p }; ev.emit('state', state); },
  };
  return t;
}

describe('media session: provider chain and degradation (mock transports)', () => {
  const chainOf = (...p) => p.map((provider) => ({ provider }));
  const make = (t) => (e) => t[e.provider] ?? createSimulatedTransport();

  it('uses the first provider that connects', async () => {
    const t = { livekit: fake('livekit'), hls: fake('hls') };
    const s = createMediaSession({ chain: chainOf('livekit', 'hls', 'simulated'), create: make(t) });
    await s.start();
    expect(s.snapshot().provider).toBe('livekit');
    expect(t.hls.connect).not.toHaveBeenCalled();
  });

  it('skips a provider that fails and records why', async () => {
    const t = { livekit: fake('livekit', { connect: 'fail' }), hls: fake('hls') };
    const s = createMediaSession({ chain: chainOf('livekit', 'hls', 'simulated'), create: make(t) });
    await s.start();
    expect(s.snapshot().provider).toBe('hls');
    expect(s.snapshot().failures).toEqual([{ provider: 'livekit', reason: 'boom' }]);
    expect(t.livekit.destroyed).toBe(true);
  });

  it('skips a provider that never connects (timeout) and ends on simulated, labelled as such', async () => {
    const t = { livekit: fake('livekit', { connect: 'hang' }), hls: fake('hls', { connect: 'fail' }) };
    const s = createMediaSession({ chain: chainOf('livekit', 'hls', 'simulated'), create: make(t), connectTimeoutMs: 30 });
    await s.start();
    const snap = s.snapshot();
    expect(snap.provider).toBe('simulated');
    expect(snap.simulated).toBe(true);
    expect(snap.failures.map((f) => f.provider)).toEqual(['livekit', 'hls']);
  });

  it('an unavailable provider (create → null) is skipped', async () => {
    const s = createMediaSession({ chain: chainOf('livekit', 'simulated'), create: (e) => (e.provider === 'livekit' ? null : createSimulatedTransport()) });
    await s.start();
    expect(s.snapshot().provider).toBe('simulated');
  });

  it('degrades mid-stream when the active provider fails', async () => {
    const t = { livekit: fake('livekit'), hls: fake('hls') };
    const s = createMediaSession({ chain: chainOf('livekit', 'hls', 'simulated'), create: make(t) });
    await s.start();
    t.livekit.push({ status: 'failed', error: 'Disconnected from the media server' });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.snapshot().provider).toBe('hls');
    expect(s.snapshot().failures[0]).toMatchObject({ provider: 'livekit', reason: 'Disconnected from the media server' });
  });

  it('degrades when a provider stays in "waiting" too long', async () => {
    const t = { livekit: fake('livekit', { connect: 'waiting' }), hls: fake('hls') };
    const s = createMediaSession({ chain: chainOf('livekit', 'hls', 'simulated'), create: make(t), stallMs: 25 });
    await s.start();
    expect(s.snapshot().provider).toBe('livekit');
    await new Promise((r) => setTimeout(r, 80));
    expect(s.snapshot().provider).toBe('hls');
    expect(s.snapshot().failures[0].reason).toBe('stalled');
  });

  it('applies the server-chosen layer to the active transport, including after a fallback', async () => {
    const t = { livekit: fake('livekit', { connect: 'fail' }), hls: fake('hls') };
    const s = createMediaSession({ chain: chainOf('livekit', 'hls', 'simulated'), create: make(t) });
    s.setLayer('480p');
    await s.start();
    expect(t.hls.layers).toEqual(['480p']);
    s.setLayer('AUDIO');
    s.setLayer(null);
    expect(t.hls.layers).toEqual(['480p', 'AUDIO', null]);
  });

  it('the simulated provider can never fail the chain', async () => {
    const s = createMediaSession({ chain: chainOf('simulated'), create: () => createSimulatedTransport() });
    await s.start();
    expect(s.snapshot()).toMatchObject({ provider: 'simulated', simulated: true });
  });

  it('destroy stops everything', async () => {
    const t = { livekit: fake('livekit') };
    const s = createMediaSession({ chain: chainOf('livekit', 'simulated'), create: make(t) });
    await s.start();
    s.destroy();
    expect(t.livekit.destroyed).toBe(true);
  });
});

describe('HLS transport (mock hls.js): the server picks the level, ABR is off', () => {
  function mockHls(levels) {
    const handlers = {};
    class H {
      static isSupported() { return true; }
      static Events = { MANIFEST_PARSED: 'mp', FRAG_LOADED: 'fl', FRAG_BUFFERED: 'fb', ERROR: 'err' };
      constructor() { this.levels = levels; this.currentLevel = -1; this.started = 0; this.stopped = 0; H.last = this; }
      on(e, f) { handlers[e] = f; }
      loadSource() {}
      attachMedia() { queueMicrotask(() => { handlers.mp?.(); handlers.fl?.(); }); }
      startLoad() { this.started++; }
      stopLoad() { this.stopped++; }
      destroy() { this.destroyed = true; }
    }
    return { H, handlers };
  }
  const levels = [{ height: 240, bitrate: 300000 }, { height: 480, bitrate: 900000 }, { height: 720, bitrate: 1900000 }, { height: 0, width: 0, bitrate: 35000 }];

  it('connects, pins the level for each layer, and stops loading for text-only', async () => {
    const { H } = mockHls(levels);
    const video = { pause: vi.fn(), play: vi.fn(async () => {}) };
    const t = createHlsTransport({ playlistUrl: '/x/master.m3u8', video, deps: { loadHls: async () => H } });
    t.setLayer('480p'); // before the manifest: remembered
    await t.connect();
    expect(H.last.currentLevel).toBe(1);
    t.setLayer('720p'); expect(H.last.currentLevel).toBe(2);
    t.setLayer('AUDIO'); expect(H.last.currentLevel).toBe(3);
    t.setLayer(null);
    expect(H.last.stopped).toBe(1);
    expect(video.pause).toHaveBeenCalled();
    expect(t.state()).toMatchObject({ provider: 'hls', simulated: false, layer: null });
    t.destroy();
    expect(H.last.destroyed).toBe(true);
  });

  it('a fatal hls error before first media rejects connect (so the session falls back)', async () => {
    const { H, handlers } = mockHls(levels);
    H.prototype.attachMedia = function attach() { queueMicrotask(() => handlers.err?.('e', { fatal: true, details: 'manifestLoadError' })); };
    const t = createHlsTransport({ playlistUrl: '/x', video: {}, deps: { loadHls: async () => H } });
    await expect(t.connect()).rejects.toThrow(/manifestLoadError/);
    expect(t.state().status).toBe('failed');
  });
});

describe('LiveKit transport (mock livekit-client): subscribe-only viewer, layer control', () => {
  function mockLk({ publishing = true } = {}) {
    const handlers = {};
    const videoPub = { setSubscribed: vi.fn(), setVideoQuality: vi.fn(), isSubscribed: true, track: null };
    const audioPub = { setSubscribed: vi.fn() };
    class Room {
      constructor(opts) {
        this.opts = opts;
        Room.last = this;
        this.remoteParticipants = new Map(publishing ? [['p', { trackPublications: new Map([['v', videoPub]]) }]] : []);
      }
      on(e, f) { handlers[e] = f; }
      async connect(url, token, o) { this.args = [url, token, o]; }
      disconnect() { this.gone = true; }
    }
    const lk = { Room, RoomEvent: { TrackSubscribed: 'ts', TrackPublished: 'tp', TrackUnsubscribed: 'tu', Disconnected: 'dc', Reconnecting: 'rc', Reconnected: 'rd' }, VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 } };
    return { lk, Room, handlers, videoPub, audioPub };
  }
  const viewer = (m) => createLivekitTransport({ url: 'wss://x', token: 'tok', deps: { loadLivekit: async () => m.lk } });

  it('connects with the viewer token and reports waiting when nobody is publishing', async () => {
    const m = mockLk({ publishing: false });
    const t = viewer(m);
    await t.connect();
    expect(m.Room.last.args.slice(0, 2)).toEqual(['wss://x', 'tok']);
    expect(m.Room.last.opts).toMatchObject({ adaptiveStream: false, dynacast: false }); // no client-side adaptation: the server decides
    expect(t.state().status).toBe('waiting');
  });

  it('maps layers to simulcast quality and unsubscribes video for audio-only / text-only', async () => {
    const m = mockLk();
    const t = viewer(m);
    await t.connect();
    const track = (kind) => ({ kind, attach: vi.fn(), detach: vi.fn() });
    m.handlers.ts(track('video'), m.videoPub);
    m.handlers.ts(track('audio'), m.audioPub);
    t.setLayer('480p');
    expect(m.videoPub.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(m.videoPub.setVideoQuality).toHaveBeenLastCalledWith(1);
    t.setLayer('240p');
    expect(m.videoPub.setVideoQuality).toHaveBeenLastCalledWith(0);
    t.setLayer('AUDIO');
    expect(m.videoPub.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(m.audioPub.setSubscribed).toHaveBeenLastCalledWith(true);
    t.setLayer(null);
    expect(m.audioPub.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(t.state()).toMatchObject({ status: 'live', layer: null, simulated: false });
  });

  it('a dropped connection is reported as failed so the session can fall back', async () => {
    const m = mockLk();
    const t = viewer(m);
    await t.connect();
    m.handlers.dc();
    expect(t.state()).toMatchObject({ status: 'failed' });
  });

  it('samples real stats into engine-ready metrics', async () => {
    const m = mockLk();
    const t = viewer(m);
    await t.connect();
    let bytes = 0;
    m.videoPub.track = {
      receiver: {
        getStats: async () => new Map([
          ['v', { type: 'inbound-rtp', bytesReceived: (bytes += 125_000), packetsReceived: bytes / 1000, packetsLost: 0, jitter: 0.004 }],
          ['p', { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.04 }],
        ]),
      },
    };
    expect(await t.sample(0)).toBeNull();
    const out = await t.sample(1000);
    expect(out).toMatchObject({ receiveKbps: 1000, latencyMs: 40, jitterMs: 4, packetLoss: 0 });
    expect(t.getStats()).toBe(out);
  });
});

describe('broadcaster ingest (mock livekit + media devices)', () => {
  it('publishes ONE simulcast stream with 480p and 240p layers, and stops cleanly', async () => {
    const { startIngest, simulcastOptions } = await import('../src/lib/media/ingest.js');
    const published = [];
    const stopped = [];
    const lk = {
      VideoPreset: class { constructor(w, h, b, f) { Object.assign(this, { width: w, height: h, maxBitrate: b, maxFramerate: f }); } },
      Room: class { constructor() { this.localParticipant = { publishTrack: async (t, o) => { published.push({ t, o }); return { track: { getSenderStats: async () => [{ rid: 'f', frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, targetBitrate: 1_800_000, qualityLimitationReason: 'none' }] } }; } }; } on() {} async connect() {} disconnect() { this.gone = true; } },
      RoomEvent: { Disconnected: 'd', Reconnecting: 'r', Reconnected: 'rr' },
      Track: { Source: { Camera: 'camera', Microphone: 'mic', ScreenShare: 'screen' } },
    };
    const mk = (kind) => ({ kind, stop: () => stopped.push(kind) });
    const stream = { getVideoTracks: () => [mk('v')], getAudioTracks: () => [mk('a')], getTracks: () => [mk('v'), mk('a')] };
    const h = await startIngest({ url: 'wss://x', token: 't', source: 'camera', deps: { loadLivekit: async () => lk, getMedia: { getUserMedia: async () => stream } } });
    expect(h.state).toBe('live');
    const opt = published[0].o;
    expect(opt.simulcast).toBe(true);
    expect(opt.videoSimulcastLayers.map((l) => l.height)).toEqual([480, 240]);
    expect(opt.videoEncoding.maxBitrate).toBe(1_800_000);
    expect(simulcastOptions(lk).videoSimulcastLayers).toHaveLength(2);
    expect(published).toHaveLength(2); // video + audio
    expect((await h.health()).layers[0]).toMatchObject({ height: 720, fps: 30, kbps: 1800, limited: null });
    await h.stop();
    expect(h.state).toBe('stopped');
    expect(stopped.length).toBeGreaterThan(0);
  });
  it('a denied source releases everything and rejects', async () => {
    const { startIngest } = await import('../src/lib/media/ingest.js');
    const lk = { Room: class { on() {} disconnect() {} }, RoomEvent: {}, Track: { Source: {} }, VideoPreset: class {} };
    await expect(startIngest({ url: 'u', token: 't', source: 'camera', deps: { loadLivekit: async () => lk, getMedia: { getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } } })).rejects.toThrow('denied');
  });
});
