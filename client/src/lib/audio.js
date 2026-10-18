/**
 * Sound, speech and vibration for alerts. Everything here is progressive: browsers that block
 * audio until a gesture, lack speech voices for a language, or have no vibration motor simply
 * do nothing — the visual alert never depends on any of it.
 */
import { LANGUAGES } from '@zerosignal/shared';
import { getPrefs } from './prefs.js';

let ctx = null;
const audioCtx = () => {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
};

/** Call from a user gesture so later alerts are allowed to make noise. */
export const unlockAudio = () => audioCtx();

const PATTERNS = {
  CRITICAL: { notes: [880, 660, 880, 660, 880], step: 0.18, vibrate: [300, 120, 300, 120, 600] },
  HIGH: { notes: [660, 520], step: 0.22, vibrate: [200, 100, 200] },
  NORMAL: { notes: [520], step: 0.2, vibrate: [120] },
  LOW: { notes: [440], step: 0.2, vibrate: [] },
};

export function alertTone(priority = 'NORMAL') {
  const p = getPrefs();
  const pat = PATTERNS[priority] ?? PATTERNS.NORMAL;
  if (p.vibrate && pat.vibrate.length) {
    try {
      navigator.vibrate?.(pat.vibrate);
    } catch {
      /* unsupported */
    }
  }
  if (!p.sound) return;
  const c = audioCtx();
  if (!c) return;
  pat.notes.forEach((f, i) => {
    const t = c.currentTime + i * pat.step;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'square';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + pat.step * 0.9);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + pat.step);
  });
}

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Does this browser have a voice for the language? (Tamil/Telugu voices are often missing.) */
export function hasVoice(lang) {
  if (!speechSupported()) return false;
  const code = (LANGUAGES[lang]?.speech ?? 'en-IN').toLowerCase();
  return window.speechSynthesis.getVoices().some((v) => v.lang.toLowerCase().startsWith(code.slice(0, 2)));
}

/** @returns {boolean} whether speech was started */
export function speak(text, lang = 'en') {
  if (!speechSupported() || !text) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANGUAGES[lang]?.speech ?? 'en-IN';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

export const stopSpeaking = () => {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
};
