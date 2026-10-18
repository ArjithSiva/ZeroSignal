import IngestPanel from '../components/IngestPanel.jsx';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Power, Radio, Square, Users } from 'lucide-react';
import { toast } from 'sonner';
import ActivityLog from '../components/ActivityLog.jsx';
import { Card, Empty, Pill, Spinner } from '../components/Badges.jsx';
import Composer from '../components/Composer.jsx';
import MapView from '../components/MapView.jsx';
import MessageFeed from '../components/MessageFeed.jsx';
import ReceiverCard from '../components/ReceiverCard.jsx';
import { useOps } from '../hooks/useOps.js';
import { api, errorMessage } from '../lib/api.js';
import { TIERS } from '@zerosignal/shared';
import { TIER_META } from '../lib/ui.js';

const field = 'rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-primary';

function Create({ onCreated }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post('/broadcasts', { title, description: description || undefined });
      setTitle('');
      setDescription('');
      onCreated(data.broadcast);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={140} placeholder="Broadcast title, e.g. Cyclone Varuna — Tamil Nadu coast" className={field} aria-label="Broadcast title" />
      <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={600} placeholder="Description (optional)" className={field} aria-label="Description" />
      <button disabled={busy || title.trim().length < 3} className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 font-display text-sm font-bold text-on-primary disabled:opacity-40"><Plus size={16} aria-hidden /> Create broadcast</button>
    </form>
  );
}

function TierSummary({ receivers }) {
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));
  receivers.forEach((r) => r.tier && (counts[r.tier] += 1));
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Receivers per tier">
      {[...TIERS].reverse().map((t) => (
        <li key={t}><Pill color={counts[t] ? TIER_META[t].color : 'var(--color-faint)'}>{TIER_META[t].short}: {counts[t]}</Pill></li>
      ))}
    </ul>
  );
}

export default function Dashboard() {
  const [list, setList] = useState(null);
  const [selected, setSelected] = useState(() => {
    try { return localStorage.getItem('zerosignal.broadcast') ?? ''; } catch { return ''; }
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/broadcasts', { params: { limit: 50 } });
      setList(data.broadcasts);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pick = (id) => {
    setSelected(id);
    try { localStorage.setItem('zerosignal.broadcast', id); } catch { /* ignore */ }
  };

  const current = list?.find((b) => b.id === selected) ?? null;
  const ops = useOps(current?.id);
  const receivers = Object.values(ops.receivers);

  // Keep the broadcast row fresh when its status flips (start/stop from here or elsewhere).
  useEffect(() => {
    if (!current) return undefined;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [current, load]);

  const act = async (verb) => {
    setBusy(true);
    try {
      await api.post(`/broadcasts/${current.id}/${verb}`);
      toast.success(verb === 'start' ? 'Broadcast is live' : 'Broadcast ended');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !list) return <Card><p role="alert" className="text-critical">{error}</p><button className="mt-2 text-primary underline" onClick={load}>Try again</button></Card>;
  if (!list) return <Spinner label="Loading broadcasts" />;

  const live = current?.status === 'LIVE';
  const ended = current?.status === 'ENDED';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="font-display text-2xl font-bold">Broadcast control</h1>
          <p className="text-sm text-muted">Send an alert once; each receiver gets the richest version its link can carry.</p>
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted">Broadcast
          <select value={selected} onChange={(e) => pick(e.target.value)} className={`${field} min-w-56 text-ink`}>
            <option value="">Select a broadcast…</option>
            {list.map((b) => <option key={b.id} value={b.id}>{b.status === 'LIVE' ? '● ' : ''}{b.title} ({b.status.toLowerCase()})</option>)}
          </select>
        </label>
        {current && !ended && (
          <button type="button" disabled={busy} onClick={() => act(live ? 'stop' : 'start')} className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 font-display font-bold disabled:opacity-50 ${live ? 'bg-critical-fill text-white' : 'bg-success text-black'}`}>
            {live ? <Square size={16} aria-hidden /> : <Power size={16} aria-hidden />} {live ? 'End broadcast' : 'Go live'}
          </button>
        )}
      </div>

      {!current && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Create a broadcast"><Create onCreated={(b) => { load(); pick(b.id); }} /></Card>
          <Card title="Or open an existing one">
            {list.length === 0 ? <Empty icon={Radio} title="No broadcasts yet">Create one here to get started.</Empty> : (
              <ul className="flex flex-col gap-1.5">
                {list.slice(0, 8).map((b) => (
                  <li key={b.id}><button type="button" onClick={() => pick(b.id)} className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-primary"><span>{b.title}</span><Pill color={b.status === 'LIVE' ? 'var(--color-critical)' : 'var(--color-muted)'}>{b.status.toLowerCase()}</Pill></button></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {current && (
        <>
          {ended && <p className="rounded-lg border border-line p-3 text-sm text-muted">This broadcast has ended. Its data stays available in <Link className="text-primary underline" to="/analytics">Analytics</Link>.</p>}
          {ops.status === 'error' && <p role="alert" className="rounded-lg border border-critical/40 bg-critical/10 p-3 text-sm text-critical">{ops.error}</p>}
          {ops.status === 'reconnecting' && <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">Connection lost. Reconnecting, receiver data will refresh when it returns.</p>}

          <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <div className="flex flex-col gap-4">
              <Card title={`Receivers (${receivers.length})`} action={<TierSummary receivers={receivers} />}>
                {receivers.length === 0 ? (
                  <Empty icon={Users} title="No receivers connected">Open <Link className="text-primary underline" to={`/receiver/${current.id}`} target="_blank">a receiver in another tab</Link>, or use the Demo page to launch four simulated ones.</Empty>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {receivers.map((r) => (
                      <ReceiverCard key={r.id} r={r} selected={focus === r.id} onSelect={setFocus} onControl={(id, cmd) => ops.control(id, cmd).catch((e) => toast.error(e.message))} />
                    ))}
                  </div>
                )}
              </Card>
              <Card title="Map">
                <MapView receivers={receivers} zones={Object.values(ops.messages).filter((m) => m.zone && !m.supersededBy).map((m) => m.zone)} acks={ops.acks} relays={ops.relays.filter((r) => r.kind === 'MESH')} />
              </Card>
              <Card title="Sent alerts and delivery">
                <MessageFeed messages={ops.messages} deliveries={ops.deliveries} receivers={ops.receivers} acks={ops.acks} />
              </Card>
            </div>
            <div className="flex flex-col gap-4">
              <Card title="Media ingest (optional)"><IngestPanel broadcast={current} live={live} /></Card>
              <Card title="Compose an alert"><Composer broadcast={current} disabled={!live} /></Card>
              <Card title="Live activity"><ActivityLog events={ops.events} acks={ops.acks} relays={ops.relays} receivers={ops.receivers} /></Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
