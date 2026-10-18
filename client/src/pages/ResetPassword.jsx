import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import AuthShell, { FormError, PasswordField, primaryBtn } from '../components/AuthShell.jsx';
import { api, errorMessage } from '../lib/api.js';

/** Used for both "reset password" and "set up your account" (invite) links; they differ only in the endpoint. */
export default function ResetPassword({ mode = 'reset' }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const invite = mode === 'invite';

  const submit = async (e) => {
    e.preventDefault();
    if (pw !== again) return setError('The two passwords do not match.');
    setBusy(true);
    setError('');
    try {
      if (invite) {
        await api.post('/auth/setup-account', { token, newPassword: pw });
        toast.success('Password set. Sign in to continue.');
      } else {
        await api.post('/auth/reset-password', { token, newPassword: pw });
        toast.success('Password changed. Sign in with your new password.');
      }
      nav('/login', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title="Link not valid" subtitle="This link is missing its token. Open the link from your email again, or request a new one." footer={<Link to="/forgot-password" className="text-primary underline">Request a new link</Link>}>{null}</AuthShell>
    );
  }
  return (
    <AuthShell title={invite ? 'Set up your account' : 'Choose a new password'} subtitle={invite ? 'Pick a password to finish creating your ZeroSignal account.' : 'Pick a password you have not used elsewhere.'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <PasswordField id="new" label="New password" value={pw} onChange={setPw} autoComplete="new-password" hint="At least 10 characters. A few random words make a strong password." />
        <PasswordField id="again" label="Repeat new password" value={again} onChange={setAgain} autoComplete="new-password" />
        <FormError>{error}</FormError>
        <button disabled={busy} className={primaryBtn}>{busy ? <><Loader2 size={16} className="animate-spin" aria-hidden /> Saving…</> : invite ? 'Set password' : 'Change password'}</button>
      </form>
    </AuthShell>
  );
}
