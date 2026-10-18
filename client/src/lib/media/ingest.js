import { MEDIA_LAYERS } from '@zerosignal/shared';

/**
 * Broadcaster ingest over LiveKit: ONE simulcast publish (720p / 480p / 240p layers + audio). The server
 * then decides which layer each receiver gets. Sources: camera, microphone only, screen, or a looping video
 * file (captureStream) so a demo needs no camera.
 *
 * `deps.loadLivekit` and `deps.getMedia` are injectable for tests.
 */
export const SOURCES = ['camera', 'microphone', 'screen', 'file'];

export function simulcastOptions(lk) {
  const L = MEDIA_LAYERS;
  return {
    simulcast: true,
    videoEncoding: { maxBitrate: L['720p'].videoKbps * 1000, maxFramerate: L['720p'].fps },
    videoSimulcastLayers: [
      new lk.VideoPreset(L['480p'].width, L['480p'].height, L['480p'].videoKbps * 1000, L['480p'].fps),
      new lk.VideoPreset(L['240p'].width, L['240p'].height, L['240p'].videoKbps * 1000, L['240p'].fps),
    ],
  };
}

export async function startIngest({ url, token, source, file, previewEl, deps = {} }) {
  const lk = deps.loadLivekit ? await deps.loadLivekit() : await import('livekit-client');
  const md = deps.getMedia ?? navigator.mediaDevices;
  let streams = [];
  let fileEl = null;
  const tracks = [];

  const room = new lk.Room({ publishDefaults: { simulcast: true } });
  const events = { state: 'connecting', error: null };
  room.on(lk.RoomEvent.Disconnected, () => { events.state = 'stopped'; });
  room.on(lk.RoomEvent.Reconnecting, () => { events.state = 'reconnecting'; });
  room.on(lk.RoomEvent.Reconnected, () => { events.state = 'live'; });

  try {
    let stream;
    if (source === 'camera') stream = await md.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: true });
    else if (source === 'microphone') stream = await md.getUserMedia({ audio: true });
    else if (source === 'screen') stream = await md.getDisplayMedia({ video: true, audio: true });
    else if (source === 'file') {
      if (!file) throw new Error('Choose a video file first');
      fileEl = document.createElement('video');
      fileEl.src = URL.createObjectURL(file);
      fileEl.loop = true;
      fileEl.muted = false;
      fileEl.playsInline = true;
      await fileEl.play();
      stream = fileEl.captureStream();
    } else throw new Error('Unknown source');
    streams.push(stream);
    if (previewEl) { previewEl.srcObject = stream; previewEl.muted = true; previewEl.play?.().catch(() => {}); }

    await room.connect(url, token);
    const opts = simulcastOptions(lk);
    for (const t of stream.getVideoTracks()) tracks.push(await room.localParticipant.publishTrack(t, { ...opts, source: lk.Track.Source[source === 'screen' ? 'ScreenShare' : 'Camera'], name: source }));
    for (const t of stream.getAudioTracks()) tracks.push(await room.localParticipant.publishTrack(t, { source: lk.Track.Source.Microphone, name: `${source}-audio` }));
    if (!tracks.length) throw new Error('The source produced no audio or video');
    events.state = 'live';
  } catch (e) {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    try { room.disconnect(); } catch { /* ignore */ }
    if (fileEl) URL.revokeObjectURL(fileEl.src);
    throw e;
  }

  return {
    get state() { return events.state; },
    /** Sender-side health per simulcast layer. Real numbers from the browser; empty if the browser withholds them. */
    async health() {
      const out = { state: events.state, layers: [] };
      for (const pub of tracks) {
        try {
          const stats = await pub.track?.getSenderStats?.();
          for (const s of stats ?? []) out.layers.push({ rid: s.rid ?? 'f', width: s.frameWidth ?? 0, height: s.frameHeight ?? 0, fps: Math.round(s.framesPerSecond ?? 0), kbps: Math.round((s.targetBitrate ?? 0) / 1000), limited: s.qualityLimitationReason && s.qualityLimitationReason !== 'none' ? s.qualityLimitationReason : null });
        } catch { /* ignore */ }
      }
      return out;
    },
    async stop() {
      events.state = 'stopped';
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      try { room.disconnect(); } catch { /* ignore */ }
      if (previewEl) previewEl.srcObject = null;
      if (fileEl) { fileEl.pause(); URL.revokeObjectURL(fileEl.src); }
      streams = [];
    },
  };
}
