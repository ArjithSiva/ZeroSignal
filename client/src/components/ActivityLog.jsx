import { ArrowDownRight, ArrowUpRight, Brain, HandHelping, MessageSquareText, ShieldCheck, Waypoints } from 'lucide-react';
import { clock } from '../lib/ui.js';
import { Empty, SimBadge } from './Badges.jsx';

/** One merged, time-ordered feed of everything the system decided or observed. */
export default function ActivityLog({ events, acks, relays, receivers }) {
  const nameOf = (id) => receivers[id]?.name?.split('—')[0].trim() ?? id;
  const rows = [
    ...events.map((e) => ({ at: e.at, kind: 'quality', e })),
    ...acks.map((a) => ({ at: a.at, kind: 'ack', a })),
    ...relays.map((r) => ({ at: r.at, kind: r.kind === 'SMS' ? 'sms' : 'mesh', r })),
  ]
    .sort((x, y) => y.at - x.at)
    .slice(0, 40);
  if (!rows.length) return <Empty title="No activity yet">Tier changes, responses and fallback hops appear here as they happen.</Empty>;
  return (
    <ol className="flex flex-col gap-2 text-sm">
      {rows.map((row, i) => {
        let Icon = ShieldCheck;
        let text = '';
        let tone = 'text-muted';
        let sim = false;
        if (row.kind === 'quality') {
          const { e } = row;
          Icon = e.trigger === 'PREDICTIVE' ? Brain : e.direction === 'UP' ? ArrowUpRight : ArrowDownRight;
          tone = e.direction === 'UP' ? 'text-success' : 'text-warning';
          text = `${e.receiverName ?? nameOf(e.receiverId)}: ${e.from ? `${e.from} → ${e.to}` : e.to}${e.trigger === 'PREDICTIVE' ? ' (predicted)' : ''}. ${e.reason}`;
        } else if (row.kind === 'ack') {
          const { a } = row;
          Icon = a.status === 'SAFE' ? ShieldCheck : HandHelping;
          tone = a.status === 'SAFE' ? 'text-success' : 'text-critical';
          text = `${a.name} says ${a.status === 'SAFE' ? 'they are safe' : 'they need help'}`;
        } else if (row.kind === 'sms') {
          Icon = MessageSquareText;
          tone = 'text-warning';
          text = `SMS fallback to ${nameOf(row.r.receiverId)} (${row.r.bytes} bytes)`;
          sim = true;
        } else {
          Icon = Waypoints;
          tone = 'text-primary';
          text = `Mesh relay: ${nameOf(row.r.from)} → ${nameOf(row.r.to)}`;
          sim = true;
        }
        return (
          <li key={`${row.at}-${i}`} className="flex items-start gap-2">
            <Icon size={15} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden />
            <span className="flex-1">{text}<span className="num block text-xs text-muted">{clock(row.at)}</span></span>
            {sim && <SimBadge />}
          </li>
        );
      })}
    </ol>
  );
}
