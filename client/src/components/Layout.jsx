import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Accessibility, BarChart3, LayoutDashboard, LogOut, Menu, PlayCircle, Settings, Shield, Smartphone, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { setPref, usePrefs } from '../lib/prefs.js';
import { closeSocket } from '../lib/socket.js';
import ThemeToggle from './ThemeToggle.jsx';
import CommandPalette, { demoAction } from './CommandPalette.jsx';
import JudgeHUD from './JudgeHUD.jsx';
import Logo from './Logo.jsx';

const NAV = {
  broadcaster: [
    ['/dashboard', 'Broadcast', LayoutDashboard],
    ['/analytics', 'Analytics', BarChart3],
    ['/demo', 'Demo', PlayCircle],
    ['/receiver', 'Receiver', Smartphone],
    ['/settings', 'Settings', Settings],
  ],
  receiver: [
    ['/receiver', 'Receiver', Smartphone],
    ['/settings', 'Settings', Settings],
  ],
  admin: [
    ['/admin', 'Admin', Shield],
    ['/dashboard', 'Broadcast', LayoutDashboard],
    ['/analytics', 'Analytics', BarChart3],
    ['/demo', 'Demo', PlayCircle],
    ['/receiver', 'Receiver', Smartphone],
    ['/settings', 'Settings', Settings],
  ],
};

export default function Layout() {
  const { user, logout } = useAuth();
  const prefs = usePrefs();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const links = NAV[user?.role] ?? [];

  useEffect(() => {
    const keys = { s: 'start', a: 'autopilot', e: 'emergency', t: 'translate', r: 'reset' };
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'j') setPref({ judge: !prefs.judge });
        else if (keys[k]) {
          e.preventDefault();
          demoAction(keys[k]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs.judge]);

  const out = () => {
    closeSocket();
    logout();
    nav('/');
  };

  const linkCls = ({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-primary/15 text-primary' : 'text-muted hover:text-ink'}`;

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[60] focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-on-primary">Skip to content</a>
      <header className="no-print sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <Link to="/" aria-label="ZeroSignal home"><Logo /></Link>
          <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Main">
            {links.map(([to, label, Icon]) => (
              <NavLink key={to} to={to} className={linkCls}><Icon size={16} aria-hidden /> {label}</NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <button type="button" aria-pressed={prefs.a11y} onClick={() => setPref({ a11y: !prefs.a11y })} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-medium ${prefs.a11y ? 'border-primary text-primary' : 'border-line text-muted hover:text-ink'}`} title="Larger text and high contrast">
              <Accessibility size={15} aria-hidden /> <span className="hidden sm:inline">Easy read</span>
            </button>
            <button type="button" onClick={() => setPalette(true)} className="hidden items-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink xl:inline-flex" aria-label="Open command palette"><kbd>Ctrl K</kbd></button>
            <span className="hidden whitespace-nowrap text-xs text-muted 2xl:inline">{user?.name} · {user?.role}</span>
            <button type="button" onClick={out} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"><LogOut size={15} aria-hidden /> <span className="hidden sm:inline">Sign out</span></button>
            <button type="button" className="rounded-lg border border-line p-1.5 md:hidden" aria-expanded={open} aria-label="Menu" onClick={() => setOpen(!open)}>
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>
        {open && (
          <nav className="flex flex-col gap-1 border-t border-line p-2 md:hidden" aria-label="Main (mobile)">
            {links.map(([to, label, Icon]) => (
              <NavLink key={to} to={to} className={linkCls} onClick={() => setOpen(false)}><Icon size={16} aria-hidden /> {label}</NavLink>
            ))}
          </nav>
        )}
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-5">
        <Outlet />
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      {prefs.judge && <JudgeHUD />}
    </div>
  );
}
