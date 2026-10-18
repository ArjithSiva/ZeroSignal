/** Per-device preferences (localStorage, always wrapped — storage can be blocked). */
import { useSyncExternalStore } from 'react';

const KEY = 'zerosignal.prefs';
const DEFAULTS = { a11y: false, sound: true, vibrate: true, speak: false, judge: false };

const read = () => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
};

let prefs = read();
const listeners = new Set();

const apply = () => {
  document.documentElement.dataset.a11y = prefs.a11y ? 'on' : 'off';
};

export function setPref(patch) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  apply();
  listeners.forEach((l) => l());
}

export const getPrefs = () => prefs;
export const initPrefs = apply;

export function usePrefs() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}
