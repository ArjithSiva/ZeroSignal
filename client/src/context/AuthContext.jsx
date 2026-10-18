import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, authEvents, errorMessage, refreshSession, tokenStore, wakeServer } from '../lib/api.js';
import { closeSocket } from '../lib/socket.js';

const AuthContext = createContext(null);

/** @typedef {{ id: string, name: string, email: string, role: 'admin'|'broadcaster'|'receiver', preferredLanguage: string, theme: string|null, twoFactorEnabled: boolean, twoFactorAvailable: boolean }} User */

const REFRESH_EARLY_MS = 60_000;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(tokenStore.hasHint());
  const timer = useRef(null);

  const clearLocal = useCallback(() => {
    clearTimeout(timer.current);
    tokenStore.clear();
    closeSocket();
    setUser(null);
  }, []);

  // Keep the access token fresh while the app is open.
  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    const exp = tokenStore.expiresAt();
    if (!exp) return;
    const wait = Math.max(5_000, exp - Date.now() - REFRESH_EARLY_MS);
    timer.current = setTimeout(async () => {
      try {
        await refreshSession();
        schedule();
      } catch (e) {
        if (e.response?.status === 401) clearLocal();
        else timer.current = setTimeout(schedule, 15_000); // offline or server asleep: try again shortly
      }
    }, wait);
  }, [clearLocal]);

  const accept = useCallback(
    ({ token, expiresAt, user: u }) => {
      tokenStore.set(token, expiresAt);
      setUser(u);
      schedule();
      return u;
    },
    [schedule],
  );

  // Restore the session from the refresh cookie (only if this browser has signed in before).
  useEffect(() => {
    if (!tokenStore.hasHint()) return undefined;
    let alive = true;
    (async () => {
      try {
        await wakeServer({ maxMs: 90_000 }); // a sleeping free-tier host takes a while; do not mistake that for "signed out"
        const data = await refreshSession();
        if (alive) accept(data);
      } catch (e) {
        if (e.response?.status === 401) tokenStore.clear();
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [accept]);

  useEffect(() => {
    const onExpired = () => clearLocal();
    authEvents.addEventListener('expired', onExpired);
    return () => authEvents.removeEventListener('expired', onExpired);
  }, [clearLocal]);

  // Another tab signed out (the hint disappears): follow it.
  useEffect(() => {
    const onStorage = (e) => e.key === 'zerosignal.session' && e.newValue == null && user && clearLocal();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [user, clearLocal]);

  const login = useCallback(async (email, password, totp) => accept((await api.post('/auth/login', { email, password, ...(totp ? { totp } : {}) })).data), [accept]);
  const register = useCallback(async (body) => accept((await api.post('/auth/register', body)).data), [accept]);
  const completeInvite = useCallback(async (token, newPassword) => accept((await api.post('/auth/setup-account', { token, newPassword })).data), [accept]);
  const changePassword = useCallback(async (currentPassword, newPassword) => accept((await api.post('/auth/change-password', { currentPassword, newPassword })).data), [accept]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {}, { headers: { 'X-ZS-CSRF': '1' } });
    } catch {
      /* the cookie may already be gone; signing out locally is what matters */
    }
    clearLocal();
  }, [clearLocal]);

  const logoutEverywhere = useCallback(async () => {
    await api.post('/auth/logout-all');
    clearLocal();
  }, [clearLocal]);

  const value = useMemo(
    () => ({ user, loading, login, register, completeInvite, changePassword, logout, logoutEverywhere, setUser, errorMessage }),
    [user, loading, login, register, completeInvite, changePassword, logout, logoutEverywhere],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};

export const homeFor = (role) => (role === 'receiver' ? '/receiver' : role === 'admin' ? '/admin' : '/dashboard');
