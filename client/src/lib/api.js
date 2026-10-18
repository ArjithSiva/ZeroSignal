import axios from 'axios';

/** Empty in local dev (Vite proxies) and on Vercel (a rewrite proxies /api to the API); set only for a direct cross-site API. */
export const API_URL = (import.meta.env?.VITE_API_URL ?? '').replace(/\/$/, '');

/** Socket.IO connects here. Vercel cannot proxy WebSockets, so on Vercel this is the API's own URL while REST stays same-origin. */
export const SOCKET_URL = (import.meta.env?.VITE_SOCKET_URL ?? import.meta.env?.VITE_API_URL ?? '').replace(/\/$/, '');

const HINT_KEY = 'zerosignal.session';
const LEGACY_TOKEN_KEY = 'zerosignal.token';

const safe = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

// Older builds kept the JWT in localStorage. It is never read again; remove it.
safe(() => localStorage.removeItem(LEGACY_TOKEN_KEY));

let accessToken = null;
let accessExpiresAt = null;
const listeners = new Set();

/**
 * The access token lives in memory only (never in storage, so XSS cannot lift a long-lived credential).
 * The durable credential is the httpOnly refresh cookie, which JavaScript cannot read.
 * A tiny non-secret hint in localStorage says "this browser has signed in before" so first-time
 * visitors do not make a pointless refresh call.
 */
export const tokenStore = {
  get: () => accessToken,
  expiresAt: () => accessExpiresAt,
  set(token, expiresAt = null) {
    accessToken = token;
    accessExpiresAt = expiresAt;
    safe(() => localStorage.setItem(HINT_KEY, '1'));
    listeners.forEach((fn) => fn(token));
  },
  clear() {
    accessToken = null;
    accessExpiresAt = null;
    safe(() => localStorage.removeItem(HINT_KEY));
    listeners.forEach((fn) => fn(null));
  },
  hasHint: () => safe(() => localStorage.getItem(HINT_KEY) === '1', false),
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

const CSRF = { 'X-ZS-CSRF': '1' };

export const api = axios.create({ baseURL: `${API_URL}/api`, timeout: 20_000, withCredentials: true });

api.interceptors.request.use((cfg) => {
  const t = tokenStore.get();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

/** Fired when the session truly ended (refresh refused); the AuthProvider listens for this. */
export const authEvents = new EventTarget();

let inflight = null;
/**
 * Exchange the refresh cookie for a new access token. Single-flight: concurrent callers share one request,
 * which also keeps token rotation race-free within a tab.
 * @returns {Promise<{ token: string, user: object, expiresAt: number|null }>}
 */
export function refreshSession() {
  inflight ??= axios
    .post(`${API_URL}/api/auth/refresh`, {}, { headers: CSRF, withCredentials: true, timeout: 20_000 })
    .then((r) => {
      tokenStore.set(r.data.token, r.data.expiresAt);
      return r.data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

api.interceptors.response.use(
  (r) => r,
  async (err) => {
    const cfg = err.config;
    const isAuthCall = cfg?.url?.startsWith('/auth/');
    if (err.response?.status === 401 && cfg && !cfg._retried && !isAuthCall && tokenStore.get()) {
      cfg._retried = true;
      try {
        await refreshSession();
        return api(cfg);
      } catch (e) {
        if (e.response?.status === 401) {
          tokenStore.clear();
          authEvents.dispatchEvent(new Event('expired'));
        }
      }
    }
    return Promise.reject(err);
  },
);

/** Human-readable message from any axios/network error. */
export function errorMessage(err, fallback = 'Something went wrong. Try again.') {
  if (err?.response?.data?.error?.message) {
    const d = err.response.data.error.details;
    const first = Array.isArray(d) && d[0]?.message ? ` ${d.map((x) => x.message).join(' ')}` : '';
    return `${err.response.data.error.message}${first}`.trim();
  }
  if (err?.code === 'ECONNABORTED') return 'The server took too long to answer. It may be waking up — try again in a moment.';
  if (err?.message === 'Network Error') return 'Cannot reach the server. Check your connection, or wait a moment if it is waking up.';
  return fallback;
}

/** Machine code from an API error, e.g. 'TOTP_REQUIRED' or 'ACCOUNT_LOCKED'. */
export const errorCode = (err) => err?.response?.data?.error?.code ?? null;

/**
 * Render's free tier sleeps. Ping /api/health until the API answers, reporting progress so the
 * UI can show a quiet "starting up" state instead of an error.
 * @returns {Promise<{ db: string, waited: number }>}
 */
export async function wakeServer({ onAttempt, maxMs = 90_000, intervalMs = 2500, signal } = {}) {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    onAttempt?.({ attempt, elapsedMs: Date.now() - started });
    try {
      const { data } = await axios.get(`${API_URL}/api/health`, { timeout: 6000, signal });
      if (data?.status === 'ok') return { db: data.db, waited: Date.now() - started };
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    if (Date.now() - started > maxMs) throw new Error('The server did not wake up in time.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
