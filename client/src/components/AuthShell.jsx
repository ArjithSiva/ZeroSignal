import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import Logo from './Logo.jsx';

export const inputCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-ink outline-none placeholder:text-muted/70 focus:border-primary focus:ring-2 focus:ring-primary/25';
export const primaryBtn = 'inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-display font-bold text-on-primary hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60';

/** Centered card layout shared by every signed-out account page. */
export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <Link to="/" aria-label="ZeroSignal home" className="mb-8 self-start"><Logo /></Link>
      <h1 className="font-display text-3xl font-extrabold leading-tight">{title}</h1>
      {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
      <div className="mt-6">{children}</div>
      {footer && <div className="mt-6 text-sm text-muted">{footer}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={htmlFor} className="font-medium">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-muted" id={`${htmlFor}-hint`}>{hint}</p>}
      {error && <p className="text-xs text-critical" id={`${htmlFor}-err`} role="alert">{error}</p>}
    </div>
  );
}

/** Password input with a show/hide toggle. */
export function PasswordField({ label = 'Password', value, onChange, autoComplete = 'current-password', hint, error, required = true, id: idProp }) {
  const auto = useId();
  const id = idProp ?? auto;
  const [show, setShow] = useState(false);
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      <div className="relative">
        <input id={id} type={show ? 'text' : 'password'} required={required} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} pr-11`} aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined} />
        <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted hover:text-ink">
          {show ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </div>
    </Field>
  );
}

export const FormError = ({ children }) => (children ? <p role="alert" className="rounded-lg border border-critical/40 bg-critical/10 p-2.5 text-sm text-critical">{children}</p> : null);
