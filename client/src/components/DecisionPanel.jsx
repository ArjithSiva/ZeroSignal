import { ArrowDownRight, ArrowUpRight, Brain, Gauge, Zap } from 'lucide-react';
import { TIER_META, MODE_LABEL } from '../lib/ui.js';
import { Pill } from './Badges.jsx';
import { formatKbps } from './SignalLadder.jsx';

/** "Why did it switch?" — the engine's own explanation plus the factors behind it (spec §8.12). */
export default function DecisionPanel({ receiver, events = [], metrics }) {
  const f = receiver?.factors;
  const p = receiver?.prediction;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs text-muted">Current decision</p>
        <p className="mt-0.5 text-sm leading-relaxed">{receiver?.reason ?? 'Waiting for the first network reading…'}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {receiver?.mode && <Pill color="var(--color-primary)">{MODE_LABEL[receiver.mode]}</Pill>}
          {receiver?.trigger && (
            <Pill color={receiver.trigger === 'PREDICTIVE' ? 'var(--color-accent)' : 'var(--color-muted)'}>
              {receiver.trigger === 'PREDICTIVE' ? <Brain size={12} aria-hidden /> : <Zap size={12} aria-hidden />} {receiver.trigger === 'PREDICTIVE' ? 'Predictive switch' : 'Reactive switch'}
            </Pill>
          )}
          {receiver?.held && <Pill color="var(--color-warning)">Holding (hysteresis)</Pill>}
        </div>
      </div>

      {f && (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg border border-line p-2">
            <dt className="text-xs text-muted">Bandwidth says</dt>
            <dd className="font-display font-semibold">{f.offline ? 'Offline' : TIER_META[f.bandwidth?.tier]?.label}</dd>
            <dd className="num text-xs text-muted">{metrics ? formatKbps(metrics.bandwidthKbps) : ''}</dd>
          </div>
          <div className="rounded-lg border border-line p-2">
            <dt className="text-xs text-muted">Worst impairment</dt>
            <dd className="font-display font-semibold">{f.impairments?.length ? f.impairments[0].text : 'None'}</dd>
            <dd className="text-xs text-muted">{f.impairments?.length ? `${f.impairments.length} active` : 'Link is clean'}</dd>
          </div>
        </dl>
      )}

      {p?.predicted && (
        <div className="rounded-lg border border-violet-400/40 bg-violet-400/10 p-3 text-sm" role="status">
          <p className="flex items-center gap-1.5 font-semibold text-violet-300">
            <Gauge size={14} aria-hidden /> Network predicted to degrade
          </p>
          <p className="mt-1 text-muted">{p.message}</p>
          {p.detail && <p className="mt-1 text-xs text-muted">{p.detail}</p>}
        </div>
      )}

      {receiver?.delivery?.note && <p className="text-xs text-muted">{receiver.delivery.note}</p>}

      <div>
        <p className="mb-1.5 text-xs text-muted">Recent switches</p>
        {events.length === 0 ? (
          <p className="text-sm text-muted">No tier change yet. Move the bandwidth slider.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {events.slice(0, 6).map((e, i) => {
              const Icon = e.direction === 'UP' ? ArrowUpRight : ArrowDownRight;
              return (
                <li key={`${e.at}-${i}`} className={`flex items-start gap-2 text-sm ${i === 0 ? '' : 'opacity-80'}`}>
                  <Icon size={15} className={`mt-0.5 shrink-0 ${e.direction === 'DOWN' ? 'text-warning' : 'text-success'}`} aria-hidden />
                  <span>
                    <span className="font-semibold">{e.from ? `${e.from} → ${e.to}` : e.to}</span>
                    {e.trigger === 'PREDICTIVE' && <span className="text-violet-300"> · predicted</span>}
                    <span className="block text-xs text-muted">{e.reason}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
