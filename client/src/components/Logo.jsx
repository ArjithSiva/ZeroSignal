/** Mark: four signal bars that collapse to a single dot — the network failing, the message still arriving. */
export function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="2" y="18" width="4" height="12" rx="2" fill="var(--color-primary)" opacity="0.25" />
      <rect x="9" y="12" width="4" height="18" rx="2" fill="var(--color-primary)" opacity="0.45" />
      <rect x="16" y="6" width="4" height="24" rx="2" fill="var(--color-primary)" opacity="0.7" />
      <circle cx="26" cy="26" r="4" fill="var(--color-critical)" />
    </svg>
  );
}

export default function Logo({ className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2 font-display text-lg font-extrabold tracking-tight ${className}`}>
      <LogoMark /> ZeroSignal
    </span>
  );
}
