import { useEffect, useMemo, useState } from 'react';
import { Pause, Play, Rewind } from 'lucide-react';
import { stateAt, timelineBounds } from '../lib/replay.js';
import { CATEGORY_LABEL, TIER_META, clock } from '../lib/ui.js';
import { Empty, Pill, PriorityBadge } from './Badges.jsx';
import { formatKbps } from './SignalLadder.jsx';

const SPEEDS = [1, 10, 30, 60];

/** Scrub back through a finished broadcast and watch tiers, alerts and responses replay. */
export default function Replay({ timeline }) {
  const bounds = useMemo(() => timelineBounds(timeline), [timeline]);
  const [t, setT] = useState(bounds?.start ?? 0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);

  useEffect(() => {
    setT(bounds?.start ?? 0);
    setPlaying(false);
  }, [bounds?.start]);

  useEffect(() => {
    if (!playing || !bounds) return undefined;
    const id = setInterval(() => {
      setT((cur) => {
        const next = cur + 250 * speed;
        if (next >= bounds.end) {
          setPlaying(false);
          return bounds.end;
        }
        return next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [playing, speed, bounds]);

  if (!bounds) return <Empty title="Nothing to replay">This broadcast has no recorded metrics or events.</Empty>;
  const s = stateAt(timeline, t);
  const pct = ((t - bounds.start) / Math.max(1, bounds.end - bounds.start)) * 100;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => { setT(bounds.start); setPlaying(false); }} className="rounded-lg border border-line p-2 text-muted hover:text-ink" aria-label="Back to start"><Rewind size={16} /></button>
        <button type="button" onClick={() => { if (t >= bounds.end) setT(bounds.start); setPlaying((p) => !p); }} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-display text-sm font-bold text-on-primary">
          {playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />} {playing ? 'Pause' : 'Play'}
        </button>
        <label className="flex items-center gap-2 text-sm text-muted">Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-ink">{SPEEDS.map((x) => <option key={x} value={x}>{x}×</option>)}</select>
        </label>
        <span className="num ml-auto text-sm text-muted">{clock(t)} · +{Math.round((t - bounds.start) / 1000)}s of {Math.round((bounds.end - bounds.start) / 1000)}s</span>
      </div>
      <input type="range" min={bounds.start} max={bounds.end} value={t} step={250} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Replay position" aria-valuetext={`${Math.round(pct)} percent`} className="w-full accent-[var(--color-primary)]" />

      <div className="grid gap-4 md:grid-cols-3">
        <section>
          <h3 className="mb-2 text-sm text-muted">Receivers</h3>
          {s.receivers.length === 0 ? <p className="text-sm text-muted">No readings yet at this moment.</p> : (
            <ul className="flex flex-col gap-2">
              {s.receivers.map((r) => {
                const m = r.tier ? TIER_META[r.tier] : null;
                return (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                    <span>{r.name}<span className="num block text-xs text-muted">{formatKbps(r.bandwidthKbps ?? 0)}</span></span>
                    {m && <Pill color={m.color}>{m.short}</Pill>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-sm text-muted">Alerts sent</h3>
          {s.messages.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
            <ul className="flex flex-col gap-2">
              {s.messages.map((m) => (
                <li key={m.id ?? m._id} className="rounded-lg border border-line px-3 py-2 text-sm">
                  <div className="mb-1 flex gap-1.5"><PriorityBadge priority={m.priority} /><Pill>{CATEGORY_LABEL[m.category] ?? m.category}</Pill></div>
                  {m.summary}
                </li>
              ))}
            </ul>
          )}
          {s.acks.length > 0 && <p className="mt-2 text-sm text-muted">{s.acks.length} receiver response{s.acks.length > 1 ? 's' : ''} so far</p>}
        </section>
        <section>
          <h3 className="mb-2 text-sm text-muted">Tier changes</h3>
          {s.events.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
            <ol className="flex max-h-72 flex-col gap-2 overflow-y-auto text-sm">
              {s.events.slice(0, 20).map((e, i) => (
                <li key={i}><span className="font-semibold">{e.receiverId}: {e.from ? `${e.from} → ${e.to}` : e.to}</span>{e.trigger === 'PREDICTIVE' && <span className="text-violet-300"> · predicted</span>}<span className="block text-xs text-muted">{e.reason}</span></li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
