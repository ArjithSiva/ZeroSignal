import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { setPref, usePrefs } from '../lib/prefs.js';
import { setThemeMode } from '../lib/theme.js';

export const demoAction = (type) => window.dispatchEvent(new CustomEvent('zs:demo', { detail: type }));

/** Ctrl/Cmd+K: jump anywhere or run a demo action without touching the mouse. */
export default function CommandPalette({ open, onClose }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const prefs = usePrefs();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef(null);
  const ops = user?.role !== 'receiver';

  const items = useMemo(
    () =>
      [
        ops && ['Go to Broadcast control', () => nav('/dashboard')],
        ops && ['Go to Analytics', () => nav('/analytics')],
        ops && ['Go to Demo', () => nav('/demo')],
        user?.role === 'admin' && ['Go to Admin', () => nav('/admin')],
        ['Go to Receiver', () => nav('/receiver')],
        ['Go to Settings', () => nav('/settings')],
        ['Theme: light', () => setThemeMode('light')],
        ['Theme: dark', () => setThemeMode('dark')],
        ['Theme: match system', () => setThemeMode('system')],
        ops && ['Demo: start', () => { nav('/demo'); setTimeout(() => demoAction('start'), 150); }],
        ops && ['Demo: run auto-pilot', () => { nav('/demo'); setTimeout(() => demoAction('autopilot'), 150); }],
        ops && ['Demo: trigger emergency', () => demoAction('emergency')],
        ops && ['Demo: cycle language', () => demoAction('translate')],
        ops && ['Demo: reset', () => demoAction('reset')],
        [prefs.a11y ? 'Turn off Easy read mode' : 'Turn on Easy read mode', () => setPref({ a11y: !prefs.a11y })],
        [prefs.judge ? 'Hide Judge Mode HUD' : 'Show Judge Mode HUD', () => setPref({ judge: !prefs.judge })],
        [prefs.sound ? 'Mute alert sounds' : 'Unmute alert sounds', () => setPref({ sound: !prefs.sound })],
      ].filter(Boolean),
    [ops, user?.role, prefs, nav],
  );
  const shown = items.filter(([label]) => label.toLowerCase().includes(q.trim().toLowerCase()));

  useEffect(() => {
    if (open) {
      setQ('');
      setI(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  if (!open) return null;

  const run = (item) => {
    item?.[1]();
    onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(shown.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter') run(shown[i]);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-[var(--scrim)] p-4 pt-[15vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="glass w-full max-w-lg overflow-hidden rounded-2xl" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Command size={16} className="text-muted" aria-hidden />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} placeholder="Type a command…" aria-label="Command" role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={`cmd-${i}`} className="w-full bg-transparent text-sm outline-none" />
        </div>
        <ul id="cmd-list" role="listbox" className="max-h-72 overflow-y-auto p-1">
          {shown.length === 0 && <li className="px-3 py-4 text-sm text-muted">No matching command.</li>}
          {shown.map((item, idx) => (
            <li key={item[0]} id={`cmd-${idx}`} role="option" aria-selected={idx === i} onMouseEnter={() => setI(idx)} onClick={() => run(item)} className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${idx === i ? 'bg-primary/15 text-primary' : ''}`}>{item[0]}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
