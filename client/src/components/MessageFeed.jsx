import { Inbox } from 'lucide-react';
import { CATEGORY_LABEL, CHANNEL_LABEL, clock } from '../lib/ui.js';
import { Empty, Pill, PriorityBadge, SimBadge } from './Badges.jsx';

const STATUS = {
  PENDING: ['Retrying', 'var(--color-warning)'],
  DEFERRED: ['Held', 'var(--color-muted)'],
  DELIVERED: ['Delivered', 'var(--color-success)'],
  ACKED: ['Responded', 'var(--color-primary)'],
  EXPIRED: ['Expired', 'var(--color-faint)'],
};

/** What was sent, and exactly where each copy is: delivered, retrying, held, answered, expired. */
export default function MessageFeed({ messages, deliveries, receivers, acks }) {
  const list = Object.values(messages).sort((a, b) => b.sentAt - a.sentAt);
  if (!list.length) return <Empty icon={Inbox} title="Nothing sent yet">Use a scenario preset or write an announcement. Delivery to each receiver is tracked here live.</Empty>;
  return (
    <ul className="flex flex-col gap-3">
      {list.map((m) => {
        const d = deliveries[m.id] ?? {};
        const mine = acks.filter((a) => a.messageId === m.id);
        const safe = mine.filter((a) => a.status === 'SAFE').length;
        const help = mine.filter((a) => a.status === 'NEED_HELP').length;
        return (
          <li key={m.id} className={`rounded-xl border border-line p-3 ${m.supersededBy ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <PriorityBadge priority={m.priority} />
              <Pill>{CATEGORY_LABEL[m.category] ?? m.category}</Pill>
              {m.zone && <Pill color="var(--color-accent)">Zone: {m.zone.label ?? `${m.zone.radiusKm} km`}</Pill>}
              {m.supersededBy && <Pill color="var(--color-muted)">Replaced</Pill>}
              <span className="num ml-auto text-xs text-muted">{clock(m.sentAt)}</span>
            </div>
            <p className="mt-1.5 font-display font-semibold leading-snug">{m.summary}</p>
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Delivery per receiver">
              {Object.values(receivers).map((r) => {
                const x = d[r.id];
                const [label, color] = STATUS[x?.status] ?? ['Not yet', 'var(--color-faint)'];
                const sim = x?.channel === 'SMS_SIMULATED' || x?.channel === 'MESH_SIMULATED';
                return (
                  <li key={r.id}>
                    <Pill color={color} title={x?.channel ? CHANNEL_LABEL[x.channel] : undefined}>
                      {r.name.split('—')[0].trim()}: {label}{x?.attempts > 1 ? ` ×${x.attempts}` : ''}{sim ? ' · sim' : ''}
                    </Pill>
                  </li>
                );
              })}
            </ul>
            {(safe > 0 || help > 0) && (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                {safe > 0 && <span className="text-success">{safe} safe</span>}
                {help > 0 && <span className="font-semibold text-critical">{help} need help</span>}
              </p>
            )}
            {Object.values(d).some((x) => x.channel?.endsWith('SIMULATED')) && <p className="mt-1.5"><SimBadge label="Includes simulated SMS / mesh hops" /></p>}
          </li>
        );
      })}
    </ul>
  );
}
