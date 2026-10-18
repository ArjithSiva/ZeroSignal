/**
 * Ultra-compact alert format (CAP-inspired, but deliberately tiny).
 *
 * One language per payload, always < 1 KB so it fits a 50 Kbps link (~160 ms) and a single
 * SMS-sized frame of fragments. Field names are short on purpose:
 *
 *   v  format version      id message id        ts issued (epoch s)   x expires (epoch s)
 *   p  priority (L/N/H/C)  c  category          l  language           h headline (summary)
 *   a  recommended action  b  body (optional, truncated to fit)      z  zone {lat,lng,r}
 */
import { LANGUAGES } from './config.js';

export const COMPACT_MAX_BYTES = 1024;

const PRIORITY_CODE = { LOW: 'L', NORMAL: 'N', HIGH: 'H', CRITICAL: 'C' };
export const PRIORITY_FROM_CODE = Object.freeze(Object.fromEntries(Object.entries(PRIORITY_CODE).map(([k, v]) => [v, k])));

/** UTF-8 byte length (works in Node and browsers). */
export function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

/** Deterministic JSON: object keys sorted recursively. This is what gets signed. */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function truncateToBytes(str, maxBytes) {
  if (byteLength(str) <= maxBytes) return str;
  let out = '';
  for (const ch of str) {
    if (byteLength(out + ch + '…') > maxBytes) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * Build a compact alert in one language. The optional body is trimmed so the whole payload
 * stays under `maxBytes`; the headline and action are always kept intact (they are what
 * must survive a 50 Kbps link).
 *
 * @param {object} message
 * @param {string} message.id
 * @param {string} message.priority
 * @param {string} message.category
 * @param {number} message.issuedAtSec
 * @param {number} [message.expiresAtSec]
 * @param {{ lat:number, lng:number, radiusKm:number }} [message.zone]
 * @param {Record<string, { text?:string, summary?:string, action?:string }>} message.i18n
 * @param {string} [lang]
 * @param {number} [maxBytes]
 */
export function buildCompactAlert(message, lang = 'en', maxBytes = COMPACT_MAX_BYTES) {
  const code = lang in LANGUAGES ? lang : 'en';
  const loc = message.i18n?.[code] ?? message.i18n?.en;
  if (!loc?.summary) throw new Error(`No ${code} summary available for compact alert`);

  const base = {
    v: 1,
    id: String(message.id),
    ts: message.issuedAtSec,
    x: message.expiresAtSec,
    p: PRIORITY_CODE[message.priority] ?? 'N',
    c: message.category,
    l: loc === message.i18n?.[code] ? code : 'en',
    h: loc.summary,
    a: loc.action,
    z: message.zone ? { lat: message.zone.lat, lng: message.zone.lng, r: message.zone.radiusKm } : undefined,
  };

  const withoutBody = canonicalize(base);
  const budget = maxBytes - byteLength(withoutBody) - byteLength(',"b":""');
  const payload = { ...base };
  if (loc.text && budget > 40) payload.b = truncateToBytes(loc.text, budget);
  return payload;
}

/** Size info for the "Payload Budget" UI. */
export function compactSize(payload) {
  const bytes = byteLength(canonicalize(payload));
  return { bytes, fits: bytes <= COMPACT_MAX_BYTES, secondsAt50Kbps: Math.round(((bytes * 8) / 50_000) * 1000) / 1000 };
}

/**
 * Approximate bytes per second each tier consumes — used by the Payload Budget Visualizer
 * and the "Data saved" counter. These are *nominal* encoding rates (simulated, not measured).
 */
export const TIER_BYTES_PER_SEC = Object.freeze({
  '720p': (4000 * 1000) / 8,
  '480p': (1500 * 1000) / 8,
  '240p': (400 * 1000) / 8,
  AUDIO: (32 * 1000) / 8,
  TEXT: 0,
  CACHED: 0,
});

/**
 * Bytes saved over `seconds` of broadcast versus always sending 720p, given a tier timeline.
 * @param {Array<{ tier:string, seconds:number }>} segments
 * @param {number} [alertBytes] one-off compact alert sent per text segment
 */
export function dataSaved(segments, alertBytes = 0) {
  let sent = 0;
  let baseline = 0;
  for (const s of segments) {
    sent += (TIER_BYTES_PER_SEC[s.tier] ?? 0) * s.seconds + (s.tier === 'TEXT' ? alertBytes : 0);
    baseline += TIER_BYTES_PER_SEC['720p'] * s.seconds;
  }
  return { sentBytes: Math.round(sent), baselineBytes: Math.round(baseline), savedBytes: Math.round(Math.max(0, baseline - sent)) };
}
