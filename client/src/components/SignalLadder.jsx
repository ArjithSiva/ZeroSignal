import { TIERS } from '@zerosignal/shared';
import { TIER_META } from '../lib/ui.js';
import { tint } from '../lib/theme.js';

/**
 * The signature visual: the six delivery tiers as a ladder. The lit rung is where this receiver
 * is right now; rungs above it are what the link can no longer carry.
 */
export default function SignalLadder({ tier, bandwidthKbps, compact = false }) {
  const rungs = [...TIERS].reverse();
  const active = rungs.indexOf(tier);
  return (
    <ol className="flex flex-col gap-1.5" aria-label={`Delivery tier: ${tier ? TIER_META[tier].label : 'waiting for first reading'}`}>
      {rungs.map((t, i) => {
        const meta = TIER_META[t];
        const on = i === active;
        const above = active !== -1 && i < active;
        return (
          <li
            key={t}
            aria-current={on ? 'step' : undefined}
            className="flex items-center gap-3 rounded-lg border px-3 py-1.5 transition-all duration-500"
            style={{
              borderColor: on ? meta.color : 'var(--color-line)',
              background: on ? tint(meta.color, 13) : 'transparent',
              boxShadow: on ? `0 0 22px ${tint(meta.color, 25)}` : 'none',
              opacity: above ? 0.32 : 1,
            }}
          >
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: on ? meta.color : 'var(--color-line-strong)' }} />
            <span className={`font-display text-sm ${on ? 'font-bold' : 'font-medium text-muted'}`}>{meta.short}</span>
            {!compact && <span className="truncate text-xs text-muted">{meta.blurb}</span>}
            {on && bandwidthKbps != null && <span className="num ml-auto shrink-0 text-xs font-semibold" style={{ color: meta.color }}>{formatKbps(bandwidthKbps)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export const formatKbps = (k) => (k >= 1000 ? `${(k / 1000).toFixed(k >= 10000 ? 0 : 1)} Mbps` : `${Math.round(k)} Kbps`);
