import { Radio, Volume2 } from 'lucide-react';
import { useMediaPlayback } from '../hooks/useMediaPlayback.js';
import { TIER_META } from '../lib/ui.js';
import { Pill } from './Badges.jsx';
import QualityPlayer from './QualityPlayer.jsx';

const PROVIDER_LABEL = { livekit: 'Live (WebRTC)', hls: 'Live (HLS)', simulated: 'Simulated' };

/**
 * The receiver's picture. A real provider shows an actual <video>; otherwise the labelled canvas simulation.
 * Everything shown here says which one it is. The layer is chosen by the server's adaptive engine.
 */
export default function MediaPlayer({ client, broadcastId, live, tier, layer, ...player }) {
  const { snap, loading, videoRef, audioRef } = useMediaPlayback({ client, broadcastId, live, layer });
  const real = snap.provider && snap.provider !== 'simulated';
  const st = snap.state ?? {};
  const textOnly = layer == null;
  const showReal = real && !textOnly;
  const meta = tier ? TIER_META[tier] : null;

  return (
    <div>
      {/* The real elements stay mounted so a provider can attach to them; they are hidden unless real media is showing. */}
      <div data-theme="dark" className={`relative overflow-hidden rounded-xl border border-line bg-black text-ink ${showReal && layer !== 'AUDIO' ? '' : 'hidden'}`} style={{ aspectRatio: '16 / 9' }}>
        <video ref={videoRef} className="size-full bg-black object-contain" playsInline muted autoPlay aria-label="Live broadcast video" />
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-0.5 text-xs font-semibold text-white"><Radio size={12} aria-hidden /> {st.waiting ? 'Waiting for broadcaster' : 'Real stream'}</span>
      </div>
      <audio ref={audioRef} autoPlay />
      {showReal && layer === 'AUDIO' && (
        <div className="flex aspect-video items-center justify-center rounded-xl border border-line bg-surface text-muted" role="status">
          <span className="inline-flex items-center gap-2"><Volume2 aria-hidden /> Audio only on this connection</span>
        </div>
      )}
      {!showReal && <QualityPlayer tier={tier} {...player} />}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
        <Pill color={real ? 'var(--color-success)' : 'var(--color-warning)'} title={real ? 'Real media is flowing' : 'No real media provider is active. This picture is a labelled simulation.'}>
          {loading ? 'Connecting media…' : PROVIDER_LABEL[snap.provider] ?? 'Simulated'}
        </Pill>
        {real && meta && <Pill color={meta.color}>{textOnly ? 'No media: text alert only' : `Layer ${layer}`}</Pill>}
        {real && st.bitrateKbps > 0 && <span className="num text-muted">{st.bitrateKbps} kbps</span>}
        {real && st.status === 'waiting' && <Pill color="var(--color-warning)">Waiting for the broadcaster</Pill>}
        {real && st.buffering && <Pill color="var(--color-warning)">Buffering</Pill>}
        {real && st.delayedSec > 4 && <Pill color="var(--color-muted)">{st.delayedSec}s behind live</Pill>}
        {snap.failures.length > 0 && <span className="text-muted" title={snap.failures.map((f) => `${f.provider}: ${f.reason}`).join('\n')}>Fell back from {snap.failures.map((f) => f.provider).join(', ')}</span>}
      </div>
    </div>
  );
}
