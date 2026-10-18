/**
 * Offline emergency cache: IndexedDB + signature verification.
 *
 * "Last verified alert" has to mean something. A receiver therefore verifies the server's
 * Ed25519 signature BEFORE caching, and verifies again every time it reads the cache back —
 * so a tampered entry is rejected at display time, not trusted because it was once stored.
 *
 * Verification path (first that works):
 *   1. WebCrypto Ed25519 with the server's public key (works fully offline once the key is stored);
 *   2. the server's /alerts/verify endpoint (online only) for browsers without Ed25519;
 *   3. otherwise the alert is shown as UNVERIFIED and is never cached or labelled "verified".
 */
import { canonicalize } from '@zerosignal/shared';
import { API_URL, api } from './api.js';

const DB_NAME = 'zerosignal';
const DB_VERSION = 1;
const KEY_STORAGE = 'zerosignal.publicKey';

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const textBytes = (s) => new TextEncoder().encode(s);

// ───────────────────────── IndexedDB helpers ─────────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('alerts')) db.createObjectStore('alerts', { keyPath: 'broadcastId' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result?.result ?? result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const idbPut = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
const idbDelete = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

// ───────────────────────── public key + verification ─────────────────────────
let keyPromise = null;

/** Fetch (and persist) the server's public key. Falls back to the stored copy when offline. */
export async function getPublicKey({ refresh = false } = {}) {
  if (keyPromise && !refresh) return keyPromise;
  keyPromise = (async () => {
    try {
      const { data } = await api.get('/alerts/public-key', { timeout: 6000 });
      try {
        localStorage.setItem(KEY_STORAGE, data.publicKey);
      } catch {
        /* storage may be unavailable; IDB copy below */
      }
      await idbPut('meta', { key: 'publicKey', value: data.publicKey }).catch(() => {});
      return data.publicKey;
    } catch {
      let stored = null;
      try {
        stored = localStorage.getItem(KEY_STORAGE);
      } catch {
        /* ignore */
      }
      stored ??= (await idbGet('meta', 'publicKey').catch(() => null))?.value ?? null;
      if (!stored) keyPromise = null; // let a later call retry
      return stored;
    }
  })();
  return keyPromise;
}

export const resetKeyCache = () => {
  keyPromise = null;
};

/** @returns {Promise<'verified'|'rejected'|'unverified'>} */
export async function verifySigned(entry) {
  if (!entry?.payload || !entry?.signature) return 'rejected';
  const pub = await getPublicKey();

  if (pub && globalThis.crypto?.subtle) {
    try {
      const key = await crypto.subtle.importKey('raw', b64ToBytes(pub), { name: 'Ed25519' }, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(entry.signature), textBytes(canonicalize(entry.payload)));
      return ok ? 'verified' : 'rejected';
    } catch {
      /* Ed25519 unsupported in this browser (or malformed input) — try the server */
    }
  }
  try {
    const { data } = await api.post('/alerts/verify', { payload: entry.payload, signature: entry.signature }, { timeout: 6000 });
    return data.valid ? 'verified' : 'rejected';
  } catch {
    return 'unverified';
  }
}

/** Verify every language payload of an alert → { lang: status }. */
export async function verifyAlertLanguages(signed = {}) {
  const out = {};
  await Promise.all(Object.entries(signed).map(async ([lang, entry]) => (out[lang] = await verifySigned(entry))));
  return out;
}

// ───────────────────────── the cache ─────────────────────────
/**
 * Cache the latest verified CRITICAL alert for a broadcast. Refuses anything not fully verified.
 * @returns {Promise<{ saved: boolean, reason?: string }>}
 */
export async function saveCriticalAlert(broadcastId, alert, { now = Date.now() } = {}) {
  if (alert.priority !== 'CRITICAL') return { saved: false, reason: 'Only CRITICAL alerts are cached' };
  const status = await verifyAlertLanguages(alert.signed);
  const langs = Object.keys(status);
  if (!langs.length || langs.some((l) => status[l] !== 'verified')) return { saved: false, reason: 'Signature not verified — not cached' };

  const existing = await idbGet('alerts', broadcastId).catch(() => null);
  if (existing && existing.sentAt > alert.sentAt) return { saved: false, reason: 'A newer alert is already cached' };

  await idbPut('alerts', {
    broadcastId,
    id: alert.id,
    priority: alert.priority,
    category: alert.category,
    sentAt: alert.sentAt,
    expiresAt: alert.expiresAt ?? null,
    zone: alert.zone ?? null,
    signed: alert.signed,
    receivedAt: now,
    verifiedAt: now,
  });
  return { saved: true };
}

/**
 * Read the cached alert, re-verifying every stored language. A language whose signature no
 * longer matches is reported as rejected and must not be shown as "verified".
 */
export async function readLastVerified(broadcastId, { now = Date.now() } = {}) {
  const row = await idbGet('alerts', broadcastId).catch(() => null);
  if (!row) return null;
  const languages = await verifyAlertLanguages(row.signed);
  const tampered = Object.values(languages).some((s) => s === 'rejected');
  const expiresAt = row.expiresAt ? row.expiresAt : null;
  return {
    id: row.id,
    broadcastId,
    priority: row.priority,
    category: row.category,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
    verifiedAt: row.verifiedAt,
    expiresAt,
    expired: expiresAt != null && now >= expiresAt,
    ageSec: Math.max(0, Math.round((now - row.receivedAt) / 1000)),
    zone: row.zone,
    signed: row.signed,
    languages,
    tampered,
    // Only a fully-verified entry may be presented as "Last verified alert".
    verified: !tampered && Object.values(languages).every((s) => s === 'verified'),
  };
}

export const clearCachedAlert = (broadcastId) => idbDelete('alerts', broadcastId);

/**
 * DEMO ONLY: corrupt the cached headline to show that a tampered alert is rejected.
 * It edits the stored payload but leaves the (now invalid) signature untouched.
 */
export async function tamperCachedAlert(broadcastId, headline = 'ALL CLEAR — return home') {
  const row = await idbGet('alerts', broadcastId);
  if (!row) return false;
  for (const entry of Object.values(row.signed)) entry.payload = { ...entry.payload, h: headline };
  await idbPut('alerts', row);
  return true;
}

/** Ask the service worker (if any) to cache the key and shell; harmless without one. */
export function primeServiceWorker() {
  navigator.serviceWorker?.controller?.postMessage({ type: 'PRIME', apiUrl: API_URL });
}
