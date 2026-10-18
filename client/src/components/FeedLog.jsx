import { MessageSquareText, Waypoints } from 'lucide-react';
import { clock } from '../lib/ui.js';
import { Empty, SimBadge } from './Badges.jsx';

/** Log of simulated SMS fallbacks and mesh relays this receiver took part in. */
export default function FeedLog({ feed, selfId }) {
  if (!feed.length) return <Empty title="Quiet">If this receiver goes offline during a CRITICAL alert, the server falls back to a simulated SMS or a nearby receiver (mesh). Those hops show up here.</Empty>;
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {feed.map((f, i) => (
        <li key={`${f.at}-${i}`} className="flex items-start gap-2">
          {f.kind === 'SMS' ? <MessageSquareText size={16} className="mt-0.5 text-warning" aria-hidden /> : <Waypoints size={16} className="mt-0.5 text-primary" aria-hidden />}
          <span className="flex-1">
            {f.kind === 'SMS' ? `SMS fallback · ${f.bytes} bytes` : f.direction === 'received' ? `Alert reached you via receiver ${f.from}` : `You relayed an alert to receiver ${f.to}`}
            <span className="num block text-xs text-muted">{clock(f.at)}</span>
          </span>
          <SimBadge />
        </li>
      ))}
    </ul>
  );
}
