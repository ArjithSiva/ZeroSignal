import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MailCheck } from 'lucide-react';
import AuthShell, { Field, FormError, inputCls, primaryBtn } from '../components/AuthShell.jsx';
import { api, errorMessage } from '../lib/api.js';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/forgot-password', { email: email.trim() });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset your password" subtitle="Enter your email and we will send a link to choose a new password." footer={<Link to="/login" className="text-primary underline">Back to sign in</Link>}>
      {done ? (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-success/40 bg-success/10 p-4 text-sm">
          <MailCheck size={20} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <p>If that email has an account, a reset link is on its way. It stays valid for 30 minutes. Check your spam folder if it does not arrive.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Email" htmlFor="email"><input id="email" type="email" required autoComplete="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} /></Field>
          <FormError>{error}</FormError>
          <button disabled={busy} className={primaryBtn}>{busy ? <><Loader2 size={16} className="animate-spin" aria-hidden /> Sending…</> : 'Send reset link'}</button>
        </form>
      )}
    </AuthShell>
  );
}
