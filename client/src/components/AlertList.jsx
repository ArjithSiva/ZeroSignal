import { BellOff, Radio } from 'lucide-react';
import { alertText } from '../lib/receiverClient.js';
import { CATEGORY_LABEL, CHANNEL_LABEL, clock } from '../lib/ui.js';
import { Empty, Pill, PriorityBadge, SimBadge, VerifyBadge } from './Badges.jsx';

export default function AlertList({ alerts, language, now = Date.now(), onOpen }) {
  if (!alerts.length) return <Empty icon={BellOff} title="No alerts yet">Alerts sent to this broadcast appear here, in your language, with their signature status.</Empty>;
  return (
    <ul className="flex flex-col gap-2">
      {alerts.map((a) => {
        const t = alertText(a, language);
        const expired = a.expiresAt != null && now >= a.expiresAt;
        return (
          <li key={a.id} className={`rounded-xl border border-line p-3 ${a.superseded || expired ? 'opacity-55' : ''}`}>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <PriorityBadge priority={a.priority} />
              <Pill>{CATEGORY_LABEL[a.category] ?? a.category}</Pill>
              <VerifyBadge status={a.verification} />
              {a.simulated && <SimBadge label={CHANNEL_LABEL[a.channel]} />}
              {a.superseded && <Pill color="var(--color-muted)">Replaced by a newer alert</Pill>}
              {expired && !a.superseded && <Pill color="var(--color-muted)">Expired</Pill>}
              <span className="num ml-auto text-xs text-muted">{clock(a.receivedAt)}</span>
            </div>
            <button type="button" onClick={() => onOpen?.(a)} lang={t.language} className="block w-full text-left">
              <p className="font-display font-semibold leading-snug">{t.headline}</p>
              {t.action && <p className="mt-0.5 text-sm text-muted">{t.action}</p>}
            </button>
            <p className="mt-1.5 flex items-center gap-1 text-xs text-muted">
              <Radio size={12} aria-hidden /> {CHANNEL_LABEL[a.channel] ?? a.channel}
              {a.bytes ? <span className="num"> · {a.bytes} bytes</span> : null}
              {a.acknowledged && <span> · receipt sent</span>}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
