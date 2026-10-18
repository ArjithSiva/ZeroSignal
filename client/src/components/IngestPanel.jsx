import { useEffect, useRef, useState } from 'react';
import { Camera, FileVideo, Mic, MonitorUp, Radio, Square } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api.js';
import { startIngest } from '../lib/media/ingest.js';
import { Pill } from './Badges.jsx';

const SRC = [
  ['camera', 'Camera', Camera],
  ['microphone', 'Microphone', Mic],
  ['screen', 'Screen', MonitorUp],
  ['file', 'Video file (loops)', FileVideo],
];

/**
 * Broadcaster media ingest. Real publishing needs LiveKit (WebRTC). With LiveKit unavailable the panel offers
 * the server-side HLS ladder from a generated TEST PATTERN (labelled), so the pipeline is demonstrable
 * without a camera. Nothing here is required to send alerts.
 */
export default function IngestPanel({ broadcast, live }) {
  const [cfg, setCfg] = useState(null);
  const [source, setSource] = useState('camera');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);
  const [hls, setHls] = useState(null);
  const handle = useRef(null);
  const preview = useRef(null);

  useEffect(() => {
    api.get('/media/config').then((r) => setCfg(r.data)).catch(() => setCfg({ providers: [], chain: ['simulated'] }));
  }, []);
  useEffect(() => () => { handle.current?.stop(); }, []);
  useEffect(() => { handle.current?.stop(); handle.current = null; setHealth(null); }, [broadcast.id]);

  useEffect(() => {
    if (!health) return undefined;
    const t = setInterval(async () => { if (handle.current) setHealth(await handle.current.health()); }, 2000);
    return () => clearInterval(t);
  }, [!!health]); // eslint-disable-line react-hooks/exhaustive-deps

  const has = (id) => cfg?.providers?.find((p) => p.id === id)?.available;

  const publish = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/media/${broadcast.id}/publish-token`, { provider: 'livekit' });
      handle.current = await startIngest({ url: data.url, token: data.token, source, file, previewEl: preview.current });
      setHealth(await handle.current.health());
      toast.success('Publishing');
    } catch (e) {
      toast.error(e.name === 'NotAllowedError' ? 'Permission to use that source was denied' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => { await handle.current?.stop(); handle.current = null; setHealth(null); };

  const startHls = async () => {
    setBusy(true);
    try {
      await api.post(`/media/${broadcast.id}/hls/start`, { kind: 'pattern' });
      setHls({ status: 'running' });
      toast.success('HLS test-pattern ladder started');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const stopHls = async () => { await api.post(`/media/${broadcast.id}/hls/stop`).catch(() => {}); setHls(null); };

  if (!cfg) return <p className="text-sm text-muted">Checking media providers…</p>;
  const publishing = Boolean(health);

  return (
    <div className="flex flex-col gap-3 text-sm">
      {!live && <p className="text-muted">Go live first; media is published into the live broadcast.</p>}

      {has('livekit') ? (
        <>
          <div role="radiogroup" aria-label="Media source" className="flex flex-wrap gap-2">
            {SRC.map(([id, label, Icon]) => (
              <button key={id} type="button" role="radio" aria-checked={source === id} disabled={publishing} onClick={() => setSource(id)} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs ${source === id ? 'border-primary bg-primary/15 text-primary' : 'border-line text-muted hover:text-ink'}`}>
                <Icon size={14} aria-hidden /> {label}
              </button>
            ))}
          </div>
          {source === 'file' && <input type="file" accept="video/*" disabled={publishing} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs text-muted" aria-label="Video file to loop" />}
          <video ref={preview} className={`aspect-video w-full rounded-lg bg-black ${publishing && source !== 'microphone' ? '' : 'hidden'}`} muted playsInline aria-label="Local preview" />
          <div className="flex items-center gap-2">
            {publishing ? (
              <button type="button" onClick={stop} className="inline-flex items-center gap-2 rounded-xl bg-critical-fill px-4 py-2 font-display text-sm font-bold text-white"><Square size={14} aria-hidden /> Stop publishing</button>
            ) : (
              <button type="button" disabled={busy || !live || (source === 'file' && !file)} onClick={publish} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-display text-sm font-bold text-on-primary disabled:opacity-40"><Radio size={14} aria-hidden /> Start publishing</button>
            )}
            {publishing && <Pill color="var(--color-success)">{health.state}</Pill>}
          </div>
          {publishing && (
            <table className="w-full text-xs"><caption className="sr-only">Publish health per layer</caption>
              <thead className="text-left text-muted"><tr><th>Layer</th><th>Size</th><th>fps</th><th>kbps</th><th>Limited by</th></tr></thead>
              <tbody className="num">{health.layers.length ? health.layers.map((l) => <tr key={l.rid}><td>{l.rid}</td><td>{l.width}×{l.height}</td><td>{l.fps}</td><td>{l.kbps}</td><td>{l.limited ?? '—'}</td></tr>) : <tr><td colSpan={5} className="text-muted">The browser has not reported sender stats yet.</td></tr>}</tbody>
            </table>
          )}
        </>
      ) : (
        <p className="rounded-lg border border-line p-3 text-muted">Browser publishing needs LiveKit. It is not configured on this server (set <code>LIVEKIT_URL</code>, <code>LIVEKIT_API_KEY</code>, <code>LIVEKIT_API_SECRET</code>). Receivers currently get the labelled simulated feed unless HLS is running.</p>
      )}

      {has('hls') && (
        <div className="rounded-lg border border-line p-3">
          <p className="font-medium">Server-side HLS ladder</p>
          <p className="mt-0.5 text-xs text-muted">FFmpeg encodes 720p, 480p, 240p and audio-only renditions from a <strong>generated test pattern</strong> (not a camera). {cfg.providers.find((p) => p.id === 'hls')?.local ? 'Served from this API: local use only; set HLS_BASE_URL for a CDN.' : ''}</p>
          <div className="mt-2">
            {hls ? <button type="button" onClick={stopHls} className="rounded-lg border border-line px-3 py-1.5 text-xs hover:text-ink">Stop HLS</button> : <button type="button" disabled={busy || !live} onClick={startHls} className="rounded-lg border border-line px-3 py-1.5 text-xs hover:text-ink disabled:opacity-40">Start test-pattern ladder</button>}
            {hls && <Pill color="var(--color-warning)" className="ml-2">Test pattern</Pill>}
          </div>
        </div>
      )}
    </div>
  );
}
