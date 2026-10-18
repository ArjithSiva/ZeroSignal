import { ArchiveRestore, ShieldAlert } from 'lucide-react';
import { alertText } from '../lib/receiverClient.js';
import { CATEGORY_LABEL, clock } from '../lib/ui.js';
import { Empty, Pill, VerifyBadge } from './Badges.jsx';

/** The "Last verified alert" — re-checked against its signature every time it is read back. */
export default function CachedAlert({ cached, language, offline, onTamper }) {
  if (!cached) return <Empty icon={ArchiveRestore} title="Nothing cached yet">The last verified CRITICAL alert is stored on this device so it still shows when the link drops.</Empty>;
  if (cached.tampered) {
    return (
      <div role="alert" className="rounded-xl border border-critical bg-critical/10 p-4">
        <p className="flex items-center gap-2 font-display font-bold text-critical"><ShieldAlert size={18} aria-hidden /> Cached alert rejected</p>
        <p className="mt-1 text-sm">The saved alert no longer matches its signature, so it will not be shown as verified. This is exactly what happens if stored data is altered.</p>
      </div>
    );
  }
  const t = alertText({ signed: cached.signed }, language);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill color="var(--color-success)">Last verified alert</Pill>
        <Pill>{CATEGORY_LABEL[cached.category] ?? cached.category}</Pill>
        <VerifyBadge status={cached.verified ? 'verified' : 'unverified'} />
        {cached.expired && <Pill color="var(--color-warning)">Past its expiry time</Pill>}
      </div>
      <p lang={t.language} className="font-display text-lg font-bold leading-snug">{t.headline}</p>
      {t.action && <p lang={t.language} className="text-sm text-muted">{t.action}</p>}
      <p className="text-xs text-muted">Received {clock(cached.receivedAt)}{offline ? ' · you are offline, so this may not be the latest' : ''}</p>
      {onTamper && (
        <button type="button" onClick={onTamper} className="self-start rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-ink">
          Demo: tamper with this cached copy
        </button>
      )}
    </div>
  );
}
