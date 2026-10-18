import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme.js';

const OPTIONS = [
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
  ['system', 'System', Monitor],
];

/** Three-way theme switch. `labels` shows the words (Settings); otherwise icons only (navbar). */
export default function ThemeToggle({ labels = false }) {
  const { mode, setMode } = useTheme();
  return (
    <div role="radiogroup" aria-label="Colour theme" className="inline-flex items-center rounded-lg border border-line bg-surface p-0.5">
      {OPTIONS.map(([id, label, Icon]) => {
        const on = mode === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => setMode(id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${on ? 'bg-primary text-on-primary' : 'text-muted hover:text-ink'}`}
          >
            <Icon size={14} aria-hidden />
            {labels && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
