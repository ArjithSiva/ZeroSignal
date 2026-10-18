import { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_URL } from '../lib/api.js';
import { createMediaSession } from '../lib/media/session.js';
import { createSimulatedTransport } from '../lib/media/simulatedTransport.js';
import { createHlsTransport } from '../lib/media/hlsTransport.js';
import { createLivekitTransport } from '../lib/media/livekitTransport.js';

/**
 * Real media for one receiver: asks the server for subscribe-only credentials, walks the provider chain
 * (LiveKit → HLS → simulated), and applies the layer the SERVER chose from the adaptive engine. While a real
 * WebRTC transport is active its stats feed the engine (labelled "measured").
 * Alerts never wait on this; if it fails the picture falls back and the text alert is unaffected.
 */
export function useMediaPlayback({ client, broadcastId, live, layer }) {
  const [snap, setSnap] = useState({ provider: null, simulated: true, failures: [], state: null });
  const [loading, setLoading] = useState(false);
  const [el, setEl] = useState({ video: null, audio: null });
  const sessionRef = useRef(null);
  const layerRef = useRef(layer);
  layerRef.current = layer;

  const videoRef = useCallback((node) => setEl((e) => (e.video === node ? e : { ...e, video: node })), []);
  const audioRef = useCallback((node) => setEl((e) => (e.audio === node ? e : { ...e, audio: node })), []);

  useEffect(() => {
    if (!broadcastId || !live || !el.video || !el.audio) return undefined;
    let cancelled = false;
    let timer = null;
    setLoading(true);

    (async () => {
      let creds;
      try {
        creds = (await api.post(`/media/${broadcastId}/view-token`)).data;
      } catch {
        creds = { chain: [{ provider: 'simulated' }] }; // the media API being unreachable must never block anything
      }
      if (cancelled) return;
      const create = (entry) => {
        if (entry.provider === 'livekit') return createLivekitTransport({ url: entry.url, token: entry.token, video: el.video, audio: el.audio });
        if (entry.provider === 'hls') return createHlsTransport({ playlistUrl: entry.playlistUrl.startsWith('/') ? `${API_URL}${entry.playlistUrl}` : entry.playlistUrl, video: el.video });
        if (entry.provider === 'simulated') return createSimulatedTransport();
        return null;
      };
      const chain = creds.chain.some((c) => c.provider === 'simulated') ? creds.chain : [...creds.chain, { provider: 'simulated' }];
      const session = createMediaSession({ chain, create });
      sessionRef.current = session;
      session.setLayer(layerRef.current ?? null);
      session.on('change', (s) => {
        if (cancelled) return;
        setSnap(s);
        const real = s.provider === 'livekit' && s.transport?.sample;
        client?.setMeasuredSource?.(real ? () => s.transport.getStats() : null);
      });
      await session.start();
      if (cancelled) return;
      setLoading(false);
      timer = setInterval(() => {
        const t = session.snapshot().transport;
        t?.sample?.().catch(() => {});
      }, 2000);
    })();

    return () => {
      cancelled = true;
      clearInterval(timer);
      client?.setMeasuredSource?.(null);
      sessionRef.current?.destroy();
      sessionRef.current = null;
      setSnap({ provider: null, simulated: true, failures: [], state: null });
      setLoading(false);
    };
  }, [broadcastId, live, el.video, el.audio, client]);

  // The server's engine decides the layer; the player only follows.
  useEffect(() => {
    sessionRef.current?.setLayer(layer ?? null);
  }, [layer]);

  return { snap, loading, videoRef, audioRef };
}
