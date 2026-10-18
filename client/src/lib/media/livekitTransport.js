import { createEmitter } from './emitter.js';
import { livekitQuality } from './layers.js';
import { metricsFromStats, summarizeReport } from './stats.js';

/**
 * LiveKit (WebRTC) viewer with a subscribe-only token. The broadcaster publishes one simulcast stream;
 * the server-side engine picks which layer this viewer receives: HIGH/MEDIUM/LOW for video tiers, video
 * unsubscribed for audio-only, everything unsubscribed for text-only.
 * `deps.loadLivekit` is injectable for tests.
 */
export function createLivekitTransport({ url, token, video, audio, deps = {} }) {
  const ev = createEmitter();
  let room = null;
  let lk = null;
  let videoPub = null;
  let audioPub = null;
  let wantLayer = '720p';
  let prev = null;
  let prevAt = 0;
  let latest = null;
  const recent = [];
  let state = { status: 'connecting', provider: 'livekit', simulated: false, layer: null, bitrateKbps: 0, buffering: false, error: null, waiting: false };
  const set = (p) => { state = { ...state, ...p }; ev.emit('state', state); };

  const applyLayer = () => {
    const q = livekitQuality(wantLayer);
    const wantVideo = q != null;
    const wantAudio = wantLayer != null;
    try {
      videoPub?.setSubscribed(wantVideo);
      if (wantVideo && videoPub?.isSubscribed) videoPub.setVideoQuality(lk.VideoQuality[q]);
      audioPub?.setSubscribed(wantAudio);
    } catch { /* publication may have gone away mid-switch */ }
    set({ layer: wantLayer });
  };

  const attach = (track, pub) => {
    if (track.kind === 'video') { videoPub = pub; if (video) track.attach(video); } else { audioPub = pub; if (audio) track.attach(audio); }
    set({ status: 'live', waiting: false });
    applyLayer();
  };

  return {
    provider: 'livekit',
    simulated: false,
    state: () => state,
    on: ev.on,
    async connect() {
      lk = deps.loadLivekit ? await deps.loadLivekit() : await import('livekit-client');
      room = new lk.Room({ adaptiveStream: false, dynacast: false });
      room.on(lk.RoomEvent.TrackSubscribed, attach);
      room.on(lk.RoomEvent.TrackPublished, (pub) => { pub.setSubscribed(true); });
      room.on(lk.RoomEvent.TrackUnsubscribed, (track) => { track.detach(); });
      room.on(lk.RoomEvent.Disconnected, () => set({ status: 'failed', error: 'Disconnected from the media server' }));
      room.on(lk.RoomEvent.Reconnecting, () => set({ buffering: true }));
      room.on(lk.RoomEvent.Reconnected, () => set({ buffering: false }));
      await room.connect(url, token, { autoSubscribe: true });
      // Connected. If the broadcaster is not publishing yet we are honestly "waiting", not failed.
      const publishing = [...(room.remoteParticipants?.values?.() ?? [])].some((p) => (p.trackPublications?.size ?? 0) > 0);
      set({ status: publishing ? 'live' : 'waiting', waiting: !publishing });
    },
    setLayer(layer) { wantLayer = layer; applyLayer(); },
    /** Sample real receive stats; returns the latest engine-ready metrics (or null before two samples exist). */
    async sample(now = performance.now()) {
      const pubs = [videoPub, audioPub, ...[...(room?.remoteParticipants?.values?.() ?? [])].flatMap((p) => [...(p.trackPublications?.values?.() ?? [])])];
      const pub = pubs.find((x) => x?.track);
      const report = await (pub?.track?.receiver?.getStats?.() ?? pub?.track?.getRTCStatsReport?.() ?? null);
      if (!report) return latest;
      const cur = summarizeReport(report);
      if (prev) {
        const m = metricsFromStats(prev, cur, now - prevAt, recent);
        if (m) { latest = m; recent.push(m.receiveKbps); if (recent.length > 8) recent.shift(); set({ bitrateKbps: m.receiveKbps }); }
      }
      prev = cur;
      prevAt = now;
      return latest;
    },
    getStats: () => latest,
    destroy() { try { room?.disconnect(); } catch { /* ignore */ } ev.clear(); },
  };
}
