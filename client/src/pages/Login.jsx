import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import AuthShell, { Field, FormError, PasswordField, inputCls, primaryBtn } from '../components/AuthShell.jsx';
import { homeFor, useAuth } from '../context/AuthContext.jsx';
import { errorCode, errorMessage, wakeServer } from '../lib/api.js';

/** Quiet, accurate server status. Free hosts sleep; this only speaks up when something is actually wrong or slow. */
function useServerStatus() {
  const [s, setS] = useState({ state: 'checking', waited: 0 });
  useEffect(() => {
    const ctl = new AbortController();
    wakeServer({ signal: ctl.signal, onAttempt: ({ elapsedMs }) => setS({ state: elapsedMs > 4000 ? 'waking' : 'checking', waited: elapsedMs }) })
      .then((r) => setS({ state: r.db === 'up' ? 'ready' : 'nodb', waited: r.waited }))
      .catch(() => !ctl.signal.aborted && setS({ state: 'down', waited: 0 }));
    return () => ctl.abort();
  }, []);
  return s;
}

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lockedFor, setLockedFor] = useState(0);
  const server = useServerStatus();
  const codeRef = useRef(null);

  useEffect(() => {
    if (lockedFor <= 0) return undefined;
    const t = setTimeout(() => setLockedFor((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [lockedFor]);
  useEffect(() => { if (needTotp) codeRef.current?.focus(); }, [needTotp]);

  if (user) return <Navigate to={loc.state?.from ?? homeFor(user.role)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const u = await login(email.trim(), password, needTotp ? totp : undefined);
      nav(loc.state?.from ?? homeFor(u.role), { replace: true });
    } catch (err) {
      const code = errorCode(err);
      if (code === 'TOTP_REQUIRED') {
        setNeedTotp(true);
        setError('');
      } else {
        if (code === 'ACCOUNT_LOCKED') setLockedFor(err.response.data.error.details?.retryAfterSec ?? 60);
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const status = { checking: null, ready: null, waking: `Server is starting up (${Math.round(server.waited / 1000)}s). This can take up to a minute.`, nodb: 'Server is up; the database is still connecting.', down: 'Cannot reach the server right now.' }[server.state];
  const locked = lockedFor > 0;

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to ZeroSignal."
      footer={
        <div className="flex flex-col gap-2">
          <p>New receiver? <Link to="/register" className="text-primary underline">Create an account</Link></p>
          <p className="text-xs">Broadcaster and admin accounts are created by an administrator.</p>
        </div>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate={false}>
        <Field label="Email" htmlFor="email">
          <input id="email" type="email" required autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
        </Field>
        <PasswordField id="password" value={password} onChange={setPassword} />
        {needTotp && (
          <Field label="Authentication code" htmlFor="totp" hint="Enter the 6-digit code from your authenticator app, or a backup code.">
            <input id="totp" ref={codeRef} required autoComplete="one-time-code" inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} className={`${inputCls} num tracking-widest`} />
          </Field>
        )}
        <FormError>{error}</FormError>
        {locked && <p role="status" className="text-sm text-warning">You can try again in {lockedFor >= 90 ? `${Math.ceil(lockedFor / 60)} minutes` : `${lockedFor} seconds`}.</p>}
        <button disabled={busy || locked} className={primaryBtn}>{busy ? <><Loader2 size={16} className="animate-spin" aria-hidden /> Signing in…</> : needTotp ? 'Verify and sign in' : 'Sign in'}</button>
        <Link to="/forgot-password" className="self-start text-sm text-primary underline">Forgot password?</Link>
      </form>
      <p role="status" aria-live="polite" className={`mt-6 min-h-5 text-xs ${server.state === 'down' ? 'text-critical' : 'text-muted'}`}>{status}</p>
    </AuthShell>
  );
}
