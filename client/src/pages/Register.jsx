import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { LANGUAGES, LANGUAGE_CODES } from '@zerosignal/shared';
import AuthShell, { Field, FormError, PasswordField, inputCls, primaryBtn } from '../components/AuthShell.jsx';
import { homeFor, useAuth } from '../context/AuthContext.jsx';
import { errorMessage } from '../lib/api.js';

export default function Register() {
  const { user, register } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', phone: '', language: 'en' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const set = (k) => (v) => setF((p) => ({ ...p, [k]: typeof v === 'string' ? v : v.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name: f.name.trim(), email: f.email.trim(), password: f.password, language: f.language };
      if (f.phone.trim()) body.phone = f.phone.trim();
      const u = await register(body);
      nav(homeFor(u.role), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create a receiver account" subtitle="Get verified emergency alerts that fit your connection." footer={<p>Already registered? <Link to="/login" className="text-primary underline">Sign in</Link></p>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Full name" htmlFor="name"><input id="name" required minLength={2} maxLength={80} autoComplete="name" value={f.name} onChange={set('name')} className={inputCls} /></Field>
        <Field label="Email" htmlFor="email"><input id="email" type="email" required autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} value={f.email} onChange={set('email')} className={inputCls} /></Field>
        <PasswordField id="password" value={f.password} onChange={set('password')} autoComplete="new-password" hint="At least 10 characters. A few random words make a strong password." />
        <Field label="Phone (optional)" htmlFor="phone" hint="Only used for alerts when you are offline. Never shown to other people."><input id="phone" type="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} className={inputCls} /></Field>
        <Field label="Alert language" htmlFor="language">
          <select id="language" value={f.language} onChange={set('language')} className={inputCls}>
            {LANGUAGE_CODES.map((l) => <option key={l} value={l}>{LANGUAGES[l].native} ({LANGUAGES[l].name})</option>)}
          </select>
        </Field>
        <FormError>{error}</FormError>
        <button disabled={busy} className={primaryBtn}>{busy ? <><Loader2 size={16} className="animate-spin" aria-hidden /> Creating…</> : 'Create account'}</button>
        <p className="text-xs text-muted">Your location is never collected at sign-up. You can choose to share it later in Settings.</p>
      </form>
    </AuthShell>
  );
}
