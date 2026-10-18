import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Accessibility, BadgeCheck, Languages, Smartphone, Volume2 } from 'lucide-react';
import { LANGUAGES, LANGUAGE_CODES } from '@zerosignal/shared';
import { toast } from 'sonner';
import AccountSettings from '../components/AccountSettings.jsx';
import { Card, Pill } from '../components/Badges.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, errorMessage } from '../lib/api.js';
import { getPublicKey } from '../lib/alertCache.js';
import { alertTone, hasVoice, speak, speechSupported, unlockAudio } from '../lib/audio.js';
import { setPref, usePrefs } from '../lib/prefs.js';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { useTheme } from '../lib/theme.js';

function Toggle({ id, label, hint, checked, onChange }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-4 accent-[var(--color-primary)]" />
      <span><span className="block font-medium">{label}</span><span className="text-sm text-muted">{hint}</span></span>
    </label>
  );
}

export default function Settings() {
  const { user, setUser } = useAuth();
  const prefs = usePrefs();
  const [key, setKey] = useState(null);
  const [voices, setVoices] = useState({});
  const [installEvent, setInstallEvent] = useState(null);

  useEffect(() => { getPublicKey().then(setKey); }, []);
  useEffect(() => {
    const check = () => setVoices(Object.fromEntries(LANGUAGE_CODES.map((l) => [l, hasVoice(l)])));
    check();
    window.speechSynthesis?.addEventListener?.('voiceschanged', check);
    return () => window.speechSynthesis?.removeEventListener?.('voiceschanged', check);
  }, []);
  useEffect(() => {
    const on = (e) => {
      e.preventDefault();
      setInstallEvent(e);
    };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);

  const changeLanguage = async (l) => {
    try {
      const { data } = await api.patch('/auth/me', { preferredLanguage: l });
      setUser(data.user);
      toast.success('Language saved');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="font-display text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted">{user.name} · {user.email} · {user.role}</p>
      </div>

      <Card title="Language">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Preferred language">
          {LANGUAGE_CODES.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={user.preferredLanguage === l} onClick={() => changeLanguage(l)} className={`rounded-lg border px-4 py-2 text-sm ${user.preferredLanguage === l ? 'border-primary bg-primary/15 text-primary' : 'border-line text-muted hover:text-ink'}`}>
              <Languages size={14} className="mr-1.5 inline" aria-hidden /> {LANGUAGES[l].native} <span className="text-xs">({LANGUAGES[l].name})</span>
            </button>
          ))}
        </div>
      </Card>

      <Card title="Appearance">
        <ThemeToggle labels />
        <p className="mt-2 text-xs text-muted">System follows your device setting{' '}(currently {useTheme().resolved}). Your choice is saved to your account and this device. Printed reports are always light.</p>
      </Card>

      <AccountSettings />

      <Card title="Alerts on this device">
        <div className="flex flex-col gap-2">
          <Toggle id="a11y" label="Easy read mode" hint="Larger text, black background and strong borders for low-literacy or low-vision use." checked={prefs.a11y} onChange={(v) => setPref({ a11y: v })} />
          <Toggle id="sound" label="Alert sounds" hint="A distinct tone for each priority. Critical is the loudest pattern." checked={prefs.sound} onChange={(v) => { setPref({ sound: v }); if (v) { unlockAudio(); setTimeout(() => alertTone('HIGH'), 50); } }} />
          <Toggle id="vibrate" label="Vibration" hint="Vibrate on new alerts where the device supports it." checked={prefs.vibrate} onChange={(v) => setPref({ vibrate: v })} />
          <Toggle id="speak" label="Read alerts aloud" hint="Uses this browser’s built-in voices. Not every device has a voice for every language." checked={prefs.speak} onChange={(v) => { unlockAudio(); setPref({ speak: v }); }} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Volume2 size={15} className="text-muted" aria-hidden />
          {speechSupported() ? LANGUAGE_CODES.map((l) => (
            <button key={l} type="button" onClick={() => { unlockAudio(); if (!speak(LANGUAGES[l].name === 'English' ? 'This is a test alert.' : LANGUAGES[l].native, l)) toast.error('Could not start speech'); }} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:text-ink">
              {LANGUAGES[l].native} <Pill color={voices[l] ? 'var(--color-success)' : 'var(--color-warning)'}>{voices[l] ? 'voice found' : 'no voice'}</Pill>
            </button>
          )) : <span className="text-muted">This browser has no speech synthesis.</span>}
        </div>
        <p className="mt-3"><Link to="/receiver" className="text-sm text-primary underline">Open the receiver</Link></p>
      </Card>

      <Card title="Alert authenticity">
        <p className="flex items-start gap-2 text-sm text-muted"><BadgeCheck size={16} className="mt-0.5 shrink-0 text-success" aria-hidden /> Every alert is signed with Ed25519 by the server. This browser checks the signature before showing it as verified, and again each time a cached alert is read.</p>
        <p className="mt-2 break-all text-xs text-muted">Server public key: <code className="text-ink">{key ?? 'unavailable (offline and not cached yet)'}</code></p>
      </Card>

      <Card title="Install">
        <p className="flex items-start gap-2 text-sm text-muted"><Smartphone size={16} className="mt-0.5 shrink-0" aria-hidden /> ZeroSignal installs as an app and keeps working as a shell when offline.</p>
        <button type="button" disabled={!installEvent} onClick={async () => { installEvent.prompt(); await installEvent.userChoice; setInstallEvent(null); }} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm disabled:opacity-40">
          <Accessibility size={15} aria-hidden /> {installEvent ? 'Install ZeroSignal' : 'Install is available from your browser menu'}
        </button>
      </Card>
    </div>
  );
}
