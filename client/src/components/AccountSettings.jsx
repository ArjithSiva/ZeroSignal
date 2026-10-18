import { useState } from 'react';
import { KeyRound, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from './Badges.jsx';
import { Field, FormError, PasswordField, inputCls, primaryBtn } from './AuthShell.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, errorMessage } from '../lib/api.js';

function ChangePassword() {
  const { changePassword } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await changePassword(cur, next);
      toast.success('Password changed. Your other devices were signed out.');
      setCur('');
      setNext('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-3">
      <h3 className="flex items-center gap-2 font-display text-sm font-semibold"><KeyRound size={15} aria-hidden /> Change password</h3>
      <PasswordField id="cur" label="Current password" value={cur} onChange={setCur} />
      <PasswordField id="nw" label="New password" value={next} onChange={setNext} autoComplete="new-password" hint="At least 10 characters." />
      <FormError>{error}</FormError>
      <button disabled={busy} className={`${primaryBtn} self-start`}>{busy ? <><Loader2 size={15} className="animate-spin" aria-hidden /> Saving…</> : 'Change password'}</button>
    </form>
  );
}

function TwoFactor() {
  const { user, setUser } = useAuth();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const begin = async () => { const r = await run(() => api.post('/auth/2fa/setup')); if (r) setSetup(r.data); };
  const enable = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/auth/2fa/enable', { code }));
    if (r) { setCodes(r.data.backupCodes); setSetup(null); setCode(''); setUser({ ...user, twoFactorEnabled: true }); toast.success('Two-factor authentication is on'); }
  };
  const disable = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/auth/2fa/disable', { password: pw, code }));
    if (r) { setUser({ ...user, twoFactorEnabled: false }); setPw(''); setCode(''); toast.success('Two-factor authentication is off'); }
  };

  return (
    <div className="flex max-w-md flex-col gap-3">
      <h3 className="flex items-center gap-2 font-display text-sm font-semibold"><ShieldCheck size={15} aria-hidden /> Two-factor authentication</h3>
      {codes && (
        <div role="status" className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
          <p className="font-medium">Save these backup codes now. They are shown once.</p>
          <ul className="num mt-2 grid grid-cols-2 gap-1 font-mono text-xs">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
          <button type="button" onClick={() => setCodes(null)} className="mt-2 text-xs text-primary underline">I have saved them</button>
        </div>
      )}
      {!user.twoFactorEnabled && !setup && (
        <>
          <p className="text-sm text-muted">Add a second step at sign-in using an authenticator app (Google Authenticator, Authy, 1Password and similar).</p>
          <button type="button" disabled={busy} onClick={begin} className={`${primaryBtn} self-start`}>Set up two-factor</button>
        </>
      )}
      {setup && (
        <form onSubmit={enable} className="flex flex-col gap-3">
          <p className="text-sm text-muted">Scan the code with your authenticator app, or enter the key by hand. Then type the 6-digit code it shows.</p>
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="rounded-lg bg-white p-2" />
          <p className="break-all text-xs">Key: <code className="text-ink">{setup.secret}</code></p>
          <Field label="6-digit code" htmlFor="enable-code"><input id="enable-code" required inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className={`${inputCls} num tracking-widest`} /></Field>
          <button disabled={busy} className={`${primaryBtn} self-start`}>Turn on</button>
        </form>
      )}
      {user.twoFactorEnabled && (
        <form onSubmit={disable} className="flex flex-col gap-3">
          <p className="text-sm text-success">Two-factor authentication is on.</p>
          <PasswordField id="off-pw" label="Password" value={pw} onChange={setPw} />
          <Field label="Authentication or backup code" htmlFor="off-code"><input id="off-code" required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} /></Field>
          <button disabled={busy} className="self-start rounded-xl border border-critical/50 px-4 py-2 text-sm font-medium text-critical disabled:opacity-50">Turn off</button>
        </form>
      )}
      <FormError>{error}</FormError>
    </div>
  );
}

export default function AccountSettings() {
  const { user, logoutEverywhere } = useAuth();
  const everywhere = async () => {
    if (!window.confirm('Sign out of ZeroSignal on every device, including this one?')) return;
    try {
      await logoutEverywhere();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card title="Account and security">
      <div className="flex flex-col gap-6">
        <ChangePassword />
        {user.twoFactorAvailable && <TwoFactor />}
        <div>
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold"><LogOut size={15} aria-hidden /> Sessions</h3>
          <p className="mt-1 text-sm text-muted">Lost a phone or used a shared computer? End every active session at once.</p>
          <button type="button" onClick={everywhere} className="mt-2 rounded-xl border border-line px-4 py-2 text-sm hover:border-critical hover:text-critical">Sign out everywhere</button>
        </div>
      </div>
    </Card>
  );
}
