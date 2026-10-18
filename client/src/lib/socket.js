import { io } from 'socket.io-client';
import { SOCKET_URL, refreshSession, tokenStore } from './api.js';

let socket = null;

const options = () => ({
  // A function, so every (re)connect presents the CURRENT access token: tokens rotate every few minutes
  // and the socket must never be torn down just because the token changed.
  auth: (cb) => cb({ token: tokenStore.get() }),
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 8000,
  timeout: 12_000,
});

/** If the handshake was refused because the token expired while the tab slept, refresh and try again. */
function heal(s) {
  s.on('connect_error', async (err) => {
    if (err?.message !== 'UNAUTHORIZED') return;
    try {
      await refreshSession();
      s.connect();
    } catch {
      /* session is really gone; the AuthProvider will sign the user out */
    }
  });
  return s;
}

/** One shared Socket.IO connection per tab. WebSocket first with long-polling fallback (works across Vercel ↔ Render). */
export function getSocket() {
  if (!socket) socket = heal(io(SOCKET_URL || undefined, options()));
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
}

/** Promise wrapper for acked emits; rejects if the server reports { ok: false }. */
export function emitAck(s, event, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`No answer from server for "${event}"`)), timeoutMs);
    s.emit(event, data, (res) => {
      clearTimeout(t);
      if (res?.ok === false) {
        const e = new Error(res.error?.message ?? 'Request failed');
        e.code = res.error?.code;
        reject(e);
      } else resolve(res);
    });
  });
}

/**
 * An extra, independent connection. The Demo page runs four receivers at once; alert events carry
 * no receiver id, so each receiver needs its own socket to know which alerts are its own.
 */
export function createSocket() {
  return heal(io(SOCKET_URL || undefined, options()));
}
