import { scoreColor } from '../lib/ui.js';

export default function ScoreRing({ score, label, size = 112, caption }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  const color = scoreColor(score);
  return (
    <figure className="m-0 flex flex-col items-center gap-1" aria-label={`${caption ?? 'Score'}: ${score ?? 'no reading'}`}>
      <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-line)" strokeWidth="8" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 50 50)" style={{ transition: 'stroke-dashoffset .6s, stroke .6s' }} />
        <text x="50" y="55" textAnchor="middle" className="num" fontSize="24" fontWeight="700" fill="var(--color-ink)" fontFamily="var(--font-display)">
          {score == null ? '–' : Math.round(score)}
        </text>
      </svg>
      <figcaption className="text-center text-xs text-muted">
        {caption}
        {label && <span className="block font-semibold" style={{ color }}>{label}</span>}
      </figcaption>
    </figure>
  );
}
