import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { getSocket } from '../lib/socket.js';
import { setPref } from '../lib/prefs.js';
import { api } from '../lib/api.js';
import { MODE_LABEL, TIER_META, clock } from '../lib/ui.js';

const SHORTCUTS = [['Ctrl/⌘ K', 'Command palette'], ['Alt J', 'Toggle this HUD'], ['Alt S', 'Demo: start'], ['Alt A', 'Demo: auto-pilot'], ['Alt E', 'Demo: trigger emergency'], ['Alt T', 'Demo: cycle language'], ['Alt R', 'Demo: reset']];

const summarise = (event, p) => {
  switch (event) {
    case 'quality:changed': return `${p.receiverName ?? p.receiverId}: ${p.from ?? '·'} → ${p.to} (${p.trigger?.toLowerCase()})`;
    case 'emergency:created': return `${p.priority} ${p.category}`;
    case 'alert:received': return `${p.alert?.priority} via ${p.channel}, ${p.bytes} B`;
    case 'delivery:updated': return `${p.receiverId}: ${p.status ?? ''}`;
    case 'ack:created': return `${p.name}: ${p.status}`;
    case 'mesh:relay': return `${p.from} → ${p.to} (simulated)`;
    case 'sms:simulated': return `SMS (simulated) ${p.bytes ?? ''} B`;
    default: return '';
  }
};
const LOGGED = new Set(['quality:changed', 'emergency:created', 'alert:received', 'delivery:updated', 'ack:created', 'mesh:relay', 'sms:simulated', 'alert:superseded', 'broadcast:start', 'broadcast:stop']);

/** Presenter HUD: live connection numbers, current tier/mode, an event log and the shortcut list. */
export default function JudgeHUD() {
  const [log, setLog] = useState([]);
  const [now, setNow] = useState({ tier: null, mode: null, reason: null });
  const [stats, setStats] = useState({ rtt: null, connected: false, rate: 0 });
  const count = useRef(0);

  useEffect(() => {
    const s = getSocket();
    const any = (event, p) => {
      if (event === 'receiver:state' && p?.tier) setNow({ tier: p.tier, mode: p.mode, reason: p.reason });
      if (!LOGGED.has(event)) return;
      count.current += 1;
      setLog((l) => [{ at: Date.now(), event, text: summarise(event, p ?? {}) }, ...l].slice(0, 12));
    };
    s.onAny(any);
    const tick = setInterval(async () => {
      const t = performance.now();
      let rtt = null;
      try {
        await api.get('/network/probe', { timeout: 3000 });
        rtt = Math.round(performance.now() - t);
      } catch { /* shown as offline */ }
      setStats({ rtt, connected: s.connected, rate: count.current });
      count.current = 0;
    }, 2000);
    return () => {
      s.offAny(any);
      clearInterval(tick);
    };
  }, []);

  return (
    <aside aria-label="Judge Mode HUD" className="no-print glass fixed bottom-3 right-3 z-[55] w-80 max-w-[calc(100vw-1.5rem)] rounded-2xl p-3 text-xs shadow-2xl">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="font-display text-sm font-bold">Judge Mode</h2>
        <button type="button" onClick={() => setPref({ judge: false })} aria-label="Close HUD" className="rounded p-1 text-muted hover:text-ink"><X size={14} /></button>
      </header>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-line p-1.5"><dt className="text-muted">Socket</dt><dd className={stats.connected ? 'text-success' : 'text-critical'}>{stats.connected ? 'connected' : 'down'}</dd></div>
        <div className="rounded-lg border border-line p-1.5"><dt className="text-muted">API RTT</dt><dd className="num">{stats.rtt != null ? `${stats.rtt} ms` : '–'}</dd></div>
        <div className="rounded-lg border border-line p-1.5"><dt className="text-muted">Events/2s</dt><dd className="num">{stats.rate}</dd></div>
      </dl>
      <p className="mt-2 text-muted">Current mode</p>
      <p className="font-semibold" style={{ color: now.tier ? TIER_META[now.tier].color : undefined }}>{now.tier ? `${TIER_META[now.tier].label} · ${MODE_LABEL[now.mode]}` : 'No receiver reading yet'}</p>
      {now.reason && <p className="text-muted">{now.reason}</p>}
      <p className="mb-1 mt-2 text-muted">Event log</p>
      <ol className="max-h-32 overflow-y-auto">
        {log.length === 0 && <li className="text-muted">Waiting for events…</li>}
        {log.map((l, i) => <li key={i} className="flex gap-1.5 border-t border-line py-0.5"><span className="num shrink-0 text-muted">{clock(l.at)}</span><span className="truncate"><b>{l.event}</b> {l.text}</span></li>)}
      </ol>
      <p className="mb-1 mt-2 text-muted">Shortcuts</p>
      <ul className="grid grid-cols-2 gap-x-2">{SHORTCUTS.map(([k, v]) => <li key={k}><kbd className="rounded border border-line px-1">{k}</kbd> {v}</li>)}</ul>
    </aside>
  );
}
