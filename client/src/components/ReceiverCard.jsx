import { Brain, SlidersHorizontal } from 'lucide-react';
import { LANGUAGES } from '@zerosignal/shared';
import { MODE_LABEL, TIER_META, scoreColor } from '../lib/ui.js';
import { Pill, SimBadge } from './Badges.jsx';
import { formatKbps } from './SignalLadder.jsx';
import { tint } from '../lib/theme.js';

const PRESETS = ['EXCELLENT', 'MODERATE', 'POOR', 'CRITICAL', 'OFFLINE'];

/** One receiver as the broadcaster sees it: tier, health, the reason, and remote control of its simulator. */
export default function ReceiverCard({ r, onControl, selected, onSelect }) {
  const meta = r.tier ? TIER_META[r.tier] : null;
  const gone = r.connection === 'DISCONNECTED';
  return (
    <article className={`glass rounded-2xl p-4 transition-opacity ${gone ? 'opacity-50' : ''} ${selected ? 'ring-1 ring-primary' : ''}`} style={meta ? { borderColor: tint(meta.color, 33) } : undefined}>
      <header className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => onSelect?.(r.id)} className="text-left">
          <h3 className="font-display text-base font-bold leading-tight">{r.name}</h3>
          <p className="text-xs text-muted">
            {LANGUAGES[r.language]?.name ?? r.language} · {gone ? 'disconnected' : 'connected'}
            {r.reconnects ? ` · ${r.reconnects} reconnect${r.reconnects > 1 ? 's' : ''}` : ''}
          </p>
        </button>
        {meta && (
          <span className="rounded-md px-2 py-1 font-display text-sm font-bold" style={{ background: tint(meta.color, 13), color: meta.color }}>
            {meta.short}
          </span>
        )}
      </header>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <dt className="text-[11px] text-muted">Bandwidth</dt>
          <dd className="num text-sm font-semibold">{r.metrics ? formatKbps(r.metrics.bandwidthKbps) : '–'}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">Health</dt>
          <dd className="num text-sm font-semibold" style={{ color: scoreColor(r.health?.score) }}>{r.health ? Math.round(r.health.score) : '–'}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">Quality</dt>
          <dd className="num text-sm font-semibold" style={{ color: scoreColor(r.quality?.score) }}>{r.quality ? Math.round(r.quality.score) : '–'}</dd>
        </div>
      </dl>

      {r.mode && <p className="mt-2 text-xs text-muted">{MODE_LABEL[r.mode]} · {r.reason}</p>}
      {r.prediction?.predicted && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-violet-400/40 bg-violet-400/10 p-2 text-xs text-violet-200">
          <Brain size={13} className="mt-0.5 shrink-0" aria-hidden /> {r.prediction.message}
        </p>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-1.5">
        {r.simulated ? <SimBadge label="Simulated" /> : <Pill color="var(--color-success)">Live</Pill>}
        <span className="ml-auto flex items-center gap-1" role="group" aria-label={`Set ${r.name} simulated network`}>
          <SlidersHorizontal size={13} className="text-muted" aria-hidden />
          {PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => onControl(r.id, { preset: p })} className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:border-primary hover:text-primary" title={`Simulate ${p.toLowerCase()} network on this receiver`}>
              {p === 'EXCELLENT' ? 'Great' : p === 'MODERATE' ? 'Mid' : p[0] + p.slice(1).toLowerCase()}
            </button>
          ))}
        </span>
      </footer>
    </article>
  );
}
