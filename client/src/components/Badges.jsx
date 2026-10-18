import { BadgeCheck, FlaskConical, ShieldAlert, ShieldQuestion, Loader2 } from 'lucide-react';
import { PRIORITY_META } from '../lib/ui.js';
import { tint } from '../lib/theme.js';

export function Pill({ children, color = 'var(--color-muted)', className = '', title }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${className}`} style={{ color, borderColor: tint(color, 33), background: tint(color, 8) }}>
      {children}
    </span>
  );
}

export const PriorityBadge = ({ priority }) => {
  const m = PRIORITY_META[priority] ?? PRIORITY_META.NORMAL;
  return <Pill color={m.color}>{m.label}</Pill>;
};

/** Anything produced by the simulator, the simulated SMS channel or the simulated mesh gets this. */
export const SimBadge = ({ label = 'Simulated' }) => (
  <Pill color="var(--color-warning)" title="This is a simulation, not a real network or carrier">
    <FlaskConical size={12} aria-hidden /> {label}
  </Pill>
);

export function VerifyBadge({ status }) {
  if (status === 'verified') {
    return (
      <Pill color="var(--color-success)" title="Ed25519 signature checked in this browser">
        <BadgeCheck size={12} aria-hidden /> Signature verified
      </Pill>
    );
  }
  if (status === 'rejected') {
    return (
      <Pill color="var(--color-critical)" title="The signature does not match the content. Do not trust this alert.">
        <ShieldAlert size={12} aria-hidden /> Signature rejected
      </Pill>
    );
  }
  if (status === 'pending') {
    return (
      <Pill color="var(--color-muted)">
        <Loader2 size={12} className="animate-spin" aria-hidden /> Verifying
      </Pill>
    );
  }
  return (
    <Pill color="var(--color-warning)" title="This browser could not check the signature">
      <ShieldQuestion size={12} aria-hidden /> Unverified
    </Pill>
  );
}

export const Card = ({ title, action, children, className = '', as: As = 'section' }) => (
  <As className={`glass rounded-2xl p-4 ${className}`}>
    {(title || action) && (
      <header className="mb-3 flex items-center justify-between gap-2">
        {title && <h2 className="font-display text-sm font-semibold text-muted">{title}</h2>}
        {action}
      </header>
    )}
    {children}
  </As>
);

export const Empty = ({ icon: Icon, title, children }) => (
  <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
    {Icon && <Icon size={28} className="text-muted" aria-hidden />}
    <p className="font-display text-base font-semibold">{title}</p>
    {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
  </div>
);

export const Spinner = ({ label = 'Loading' }) => (
  <div role="status" className="flex items-center justify-center gap-2 py-10 text-muted">
    <Loader2 className="animate-spin" size={18} aria-hidden /> <span className="text-sm">{label}…</span>
  </div>
);
