import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2, Radio, Volume2 } from 'lucide-react';
import { LANGUAGES, LANGUAGE_CODES } from '@zerosignal/shared';
import { toast } from 'sonner';
import { Card, Empty, Pill, Spinner } from '../components/Badges.jsx';
import ReceiverPanel from '../components/ReceiverPanel.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useReceiver } from '../hooks/useReceiver.js';
import { api, errorMessage } from '../lib/api.js';
import { unlockAudio } from '../lib/audio.js';
import { setPref, usePrefs } from '../lib/prefs.js';
import { clock } from '../lib/ui.js';

/** Demo cities. Choosing one gives the receiver a location so zone-targeted alerts can include or skip it. */
export const LOCATIONS = {
  none: ['Not shared', null],
  chennai: ['Chennai', { lat: 13.0827, lng: 80.2707 }],
  madurai: ['Madurai', { lat: 9.9252, lng: 78.1198 }],
  nagapattinam: ['Nagapattinam', { lat: 10.7672, lng: 79.8449 }],
};

function Picker() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/broadcasts', { params: { limit: 30 } }).then((r) => setRows(r.data.broadcasts)).catch((e) => setError(errorMessage(e)));
  }, []);
  if (error) return <Card><p role="alert" className="text-critical">{error}</p></Card>;
  if (!rows) return <Spinner label="Finding broadcasts" />;
  const joinable = rows.filter((b) => b.status !== 'ENDED');
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-2xl font-bold">Choose a broadcast to receive</h1>
      <p className="mt-1 text-sm text-muted">Only live or scheduled broadcasts can be joined.</p>
      <div className="mt-4 flex flex-col gap-2">
        {joinable.length === 0 && <Card><Empty icon={Radio} title="Nothing is live">Ask a broadcaster to start a broadcast to go live.</Empty></Card>}
        {joinable.map((b) => (
          <button key={b.id} type="button" onClick={() => nav(`/receiver/${b.id}`)} className="glass flex items-center justify-between gap-3 rounded-xl p-4 text-left hover:border-primary">
            <span>
              <span className="block font-display font-semibold">{b.title}</span>
              <span className="text-xs text-muted">{b.description || 'No description'}</span>
            </span>
            <Pill color={b.status === 'LIVE' ? 'var(--color-critical)' : 'var(--color-muted)'}>{b.status === 'LIVE' ? 'Live' : 'Scheduled'}</Pill>
          </button>
        ))}
      </div>
    </div>
  );
}

function Live({ broadcastId }) {
  const { user, setUser } = useAuth();
  const prefs = usePrefs();
  const [language, setLanguage] = useState(user.preferredLanguage ?? 'en');
  const [place, setPlace] = useState('none');
  const id = `r-${user.id.slice(-10)}`;
  const { client, state } = useReceiver({ broadcastId, id, name: user.name, language, location: LOCATIONS[place][1] ?? undefined });

  const changeLanguage = async (l) => {
    setLanguage(l);
    client?.setLanguage(l);
    try {
      const { data } = await api.patch('/auth/me', { preferredLanguage: l });
      setUser(data.user);
    } catch {
      /* the choice still applies for this session */
    }
  };

  if (state.status === 'error') {
    return <Card><p role="alert" className="text-critical">{state.error}</p><Link to="/receiver" className="mt-3 inline-block text-primary underline">Choose another broadcast</Link></Card>;
  }

  return (
    <div className="flex flex-col gap-4" onPointerDown={unlockAudio}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="font-display text-2xl font-bold">{state.broadcast?.title ?? 'Joining broadcast'}</h1>
          <p className="flex items-center gap-1.5 text-sm text-muted" role="status">
            {state.status === 'joined' && <><span className="size-2 rounded-full bg-success" /> Connected · {clock(Date.now())}</>}
            {(state.status === 'connecting' || state.status === 'idle') && <><Loader2 size={14} className="animate-spin" aria-hidden /> Connecting…</>}
            {state.status === 'reconnecting' && <><Loader2 size={14} className="animate-spin text-warning" aria-hidden /> <span className="text-warning">Connection lost. Reconnecting; alerts you missed will be re-sent.</span></>}
            {state.status === 'ended' && <span className="text-warning">This broadcast has ended.</span>}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          Language
          <select value={language} onChange={(e) => changeLanguage(e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-ink">
            {LANGUAGE_CODES.map((c) => <option key={c} value={c}>{LANGUAGES[c].native} · {LANGUAGES[c].name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          Location
          <select value={place} onChange={(e) => setPlace(e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-ink" title="Lets zone-targeted alerts include or skip you">
            {Object.entries(LOCATIONS).map(([k, [label]]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <button type="button" aria-pressed={prefs.speak} onClick={() => { unlockAudio(); setPref({ speak: !prefs.speak }); toast(prefs.speak ? 'Alerts will not be read aloud' : 'New alerts will be read aloud'); }} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${prefs.speak ? 'border-primary text-primary' : 'border-line text-muted'}`}>
          <Volume2 size={15} aria-hidden /> Read aloud
        </button>
      </div>
      {client && <ReceiverPanel client={client} state={state} language={language} />}
    </div>
  );
}

export default function Receiver() {
  const { broadcastId } = useParams();
  return broadcastId ? <Live key={broadcastId} broadcastId={broadcastId} /> : <Picker />;
}
