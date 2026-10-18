/**
 * Theme: light | dark | system.
 *  - `mode` is what the person chose; `resolved` is what is actually shown.
 *  - Stored in localStorage (instant, works signed-out) and mirrored to the user profile when signed in.
 *  - The same logic runs once in index.html before first paint so there is no flash.
 */
import { useSyncExternalStore } from 'react';

export const THEME_KEY = 'zerosignal.theme';
export const THEME_COLORS = { dark: '#070b14', light: '#f3f6fb' };
export const MODES = ['light', 'dark', 'system'];

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const systemTheme = () => (mq && !mq.matches ? 'light' : 'dark');

const readMode = () => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return MODES.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
};

export const resolveTheme = (mode) => (mode === 'system' ? systemTheme() : mode);

let state = { mode: readMode(), resolved: resolveTheme(readMode()) };
let printing = false;
const listeners = new Set();

function paint(resolved) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = state.mode;
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.setAttribute('href', resolved === 'light' ? '/manifest-light.webmanifest' : '/manifest.webmanifest');
}

function commit() {
  state = { mode: state.mode, resolved: resolveTheme(state.mode) };
  paint(printing ? 'light' : state.resolved);
  listeners.forEach((l) => l());
}

export function setThemeMode(mode) {
  if (!MODES.includes(mode)) return;
  state = { ...state, mode };
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage blocked: the choice lasts for this tab only */
  }
  commit();
}

export const getTheme = () => state;

export function initTheme() {
  commit();
  mq?.addEventListener?.('change', () => state.mode === 'system' && commit());
  // The printed incident report is always light, whatever the screen theme.
  window.addEventListener('beforeprint', () => { printing = true; paint('light'); });
  window.addEventListener('afterprint', () => { printing = false; paint(state.resolved); });
}

export function useTheme() {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
  return { ...s, setMode: setThemeMode };
}

/** A colour at a given opacity that works with CSS variables (replaces `${hex}22` string tricks). */
export const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
