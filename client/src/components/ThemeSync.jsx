import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { MODES, getTheme, setThemeMode, useTheme } from '../lib/theme.js';

/** Keeps the theme in step with the account: adopt the saved profile choice on sign-in, save changes back. */
export default function ThemeSync() {
  const { user } = useAuth();
  const { mode } = useTheme();
  const adopted = useRef(null);

  useEffect(() => {
    if (!user?.id && !user?._id) { adopted.current = null; return; }
    const uid = user.id ?? user._id;
    if (adopted.current === uid) return;
    adopted.current = uid;
    // A stored profile choice other than the default wins on a new device; otherwise push the local one up.
    if (user.theme && MODES.includes(user.theme) && user.theme !== 'system' && user.theme !== getTheme().mode) setThemeMode(user.theme);
  }, [user]);

  useEffect(() => {
    if (!user || adopted.current == null) return;
    if (user.theme === mode) return;
    api.patch('/auth/me', { theme: mode }).catch(() => {});
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
