import { useCallback, useEffect, useState } from 'react';
import { Copy, LogOut, Mail, Plus, Power } from 'lucide-react';
import { toast } from 'sonner';
import { Card, Empty, Pill, Spinner } from '../components/Badges.jsx';
import { api, errorMessage } from '../lib/api.js';
import { TIER_META } from '../lib/ui.js';

const field = 'rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-primary';
const TONE = { up: ['var(--color-success)', 'Operational'], fallback: ['var(--color-warning)', 'Fallback mode'], degraded: ['var(--color-warning)', 'Degraded'], connecting: ['var(--color-warning)', 'Connecting'], simulated: ['var(--color-muted)', 'Simulated only'], down: ['var(--color-critical)', 'Down'] };

function Dot({ status }) {
  const [color, label] = TONE[status] ?? ['var(--color-muted)', status];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color }}>
      <span className="size-2.5 rounded-full" style={{ background: color, boxShadow: status === 'up' ? `0 0 8px ${color}` : 'none' }} aria-hidden /> {label}
    </span>
  );
}

function HealthRow({ title, status, detail }) {
  return (
    <li className="flex items-center justify-between gap-3 border-t border-line py-2.5 first:border-t-0">
      <div>
        <p className="font-display text-sm font-semibold">{title}</p>
        {detail && <p className="text-xs text-muted">{detail}</p>}
      </div>
      <Dot status={status} />
    </li>
  );
}

function Health({ health }) {
  if (!health) return <Spinner label="Checking systems" />;
  const { api: a, mongodb, socketio, groq, streaming } = health;
  return (
    <ul>
      <HealthRow title="API" status={a.status} detail={`Up ${Math.round(a.uptimeSec / 60)} min · ${a.env}`} />
      <HealthRow title="MongoDB" status={mongodb.status} detail={mongodb.latencyMs != null ? `Ping ${mongodb.latencyMs} ms` : 'Not connected'} />
      <HealthRow title="Socket.IO" status={socketio.status} detail={`${socketio.sockets} sockets · ${socketio.connectedReceivers} receivers · ${socketio.pendingDeliveries} pending deliveries`} />
      <HealthRow title="Groq AI" status={groq.status} detail={groq.configured ? `Model ${groq.model}` : 'No API key: the labelled rule-based fallback is used'} />
      <HealthRow title="Streaming" status={streaming.status} detail={streaming.note ?? streaming.provider} />
    </ul>
  );
}

function Users({ users, me, reload }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'broadcaster' });
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(null);
  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post('/admin/users', form);
      setInvite({ email: form.email, url: data.inviteUrl });
      toast.success('Account created and invite sent');
      setForm({ name: '', email: '', role: 'broadcaster' });
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn, ok) => {
    try {
      const r = await fn();
      toast.success(ok);
      reload();
      return r;
    } catch (err) {
      toast.error(errorMessage(err));
      return null;
    }
  };
  const resend = async (u) => {
    const r = await act(() => api.post(`/admin/users/${u.id}/invite`), 'Invite sent');
    if (r) setInvite({ email: u.email, url: r.data.inviteUrl });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.url);
      toast.success('Link copied');
    } catch {
      toast.error('Copy failed. Select the link and copy it manually.');
    }
  };
  const btn = 'inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-40';
  return (
    <div className="flex flex-col gap-4">
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-left text-sm"><caption className="sr-only">Users</caption>
          <thead className="text-xs text-muted"><tr><th scope="col" className="py-1">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-line align-middle">
                <td className="py-1.5 pr-3">{u.name}</td>
                <td className="pr-3 text-muted">{u.email}</td>
                <td className="pr-3">
                  <select value={u.role} disabled={u.id === me} onChange={(e) => act(() => api.patch(`/admin/users/${u.id}/role`, { role: e.target.value }), 'Role updated')} aria-label={`Role for ${u.name}`} className="rounded border border-line bg-surface px-1.5 py-1 text-xs disabled:opacity-50">
                    <option>admin</option><option>broadcaster</option><option>receiver</option>
                  </select>
                </td>
                <td className="pr-3 text-xs">
                  {!u.active ? <Pill color="var(--color-critical)">Deactivated</Pill> : u.invitePending ? <Pill color="var(--color-warning)">Invite pending</Pill> : <Pill color="var(--color-success)">Active</Pill>}
                  {u.twoFactorEnabled && <span className="ml-1 text-muted">· 2FA</span>}
                </td>
                <td className="num pr-3 text-xs text-muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                <td className="whitespace-nowrap py-1 text-right">
                  <span className="inline-flex gap-1">
                    {u.invitePending && <button type="button" className={btn} onClick={() => resend(u)} title="Send a new invite link"><Mail size={12} aria-hidden /> Invite</button>}
                    <button type="button" className={btn} disabled={u.id === me} onClick={() => act(() => api.post(`/admin/users/${u.id}/logout`), 'Signed out everywhere')} title="End all sessions"><LogOut size={12} aria-hidden /> Sign out</button>
                    <button type="button" className={btn} disabled={u.id === me} onClick={() => act(() => api.patch(`/admin/users/${u.id}/active`, { active: !u.active }), u.active ? 'Account deactivated' : 'Account reactivated')}><Power size={12} aria-hidden /> {u.active ? 'Deactivate' : 'Reactivate'}</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={create} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto]">
        <input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" aria-label="Full name" autoComplete="off" className={field} />
        <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" aria-label="Email" autoComplete="off" className={field} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} aria-label="Role" className={field}><option>broadcaster</option><option>admin</option><option>receiver</option></select>
        <button disabled={busy} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-on-primary disabled:opacity-50"><Plus size={15} aria-hidden /> Create and invite</button>
      </form>
      <p className="text-xs text-muted">The person receives a link to set their own password. Nobody, including admins, ever sees or chooses another person’s password.</p>
      {invite && (
        <div role="status" className="rounded-lg border border-line bg-surface p-3 text-sm">
          <p className="font-medium">Invite link for {invite.email}</p>
          <p className="mt-1 text-xs text-muted">Sent by email when mail is configured. If it is not, share this link yourself; it works once and expires in 72 hours.</p>
          <div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-canvas px-2 py-1 text-xs">{invite.url}</code><button type="button" onClick={copy} className={btn}><Copy size={12} aria-hidden /> Copy</button></div>
        </div>
      )}
    </div>
  );
}

function Audit() {
  const [events, setEvents] = useState(null);
  useEffect(() => { api.get('/admin/audit', { params: { limit: 50 } }).then((r) => setEvents(r.data.events)).catch(() => setEvents([])); }, []);
  if (!events) return <Spinner label="Loading audit trail" />;
  if (!events.length) return <Empty title="No events yet" />;
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-left text-sm"><caption className="sr-only">Audit trail</caption>
        <thead className="text-xs text-muted"><tr><th scope="col" className="py-1">When</th><th scope="col">Event</th><th scope="col">IP</th></tr></thead>
        <tbody>{events.map((e) => <tr key={e.id} className="border-t border-line"><td className="num py-1.5 pr-3 text-xs text-muted">{new Date(e.at).toLocaleString()}</td><td className="pr-3 font-mono text-xs">{e.type}</td><td className="text-xs text-muted">{e.ip ?? ''}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export default function Admin() {
  const [health, setHealth] = useState(null);
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [me, setMe] = useState('');
  const [error, setError] = useState('');

  const loadHealth = useCallback(() => api.get('/admin/health').then((r) => setHealth(r.data)).catch((e) => setError(errorMessage(e))), []);
  const loadAll = useCallback(async () => {
    try {
      const [o, u, m] = await Promise.all([api.get('/admin/overview'), api.get('/admin/users'), api.get('/auth/me')]);
      setOverview(o.data);
      setUsers(u.data.users);
      setMe(m.data.user.id);
    } catch (e) {
      setError(errorMessage(e));
    }
    loadHealth();
  }, [loadHealth]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    const t = setInterval(loadHealth, 5000);
    return () => clearInterval(t);
  }, [loadHealth]);

  const c = overview?.counts;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-2xl font-bold">Admin</h1>
        <p className="text-sm text-muted">System health and people.</p>
      </div>
      {error && <p role="alert" className="rounded-lg border border-critical/40 bg-critical/10 p-3 text-sm text-critical">{error}</p>}

      <div className="grid gap-4">
        <Card title="System health" action={<span className="text-xs text-muted">refreshes every 5 s</span>}><Health health={health} /></Card>
      </div>

      {!overview ? <Spinner label="Loading overview" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[['Users', c.users], ['Broadcasts', c.broadcasts], ['Live now', c.liveBroadcasts], ['Alerts', c.messages], ['Tier changes', c.qualityEvents], ['Active receivers', c.activeReceivers]].map(([l, v]) => (
              <div key={l} className="glass rounded-2xl p-4"><p className="text-xs text-muted">{l}</p><p className="num mt-1 font-display text-3xl font-bold">{v}</p></div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Active receivers">
              {overview.activeReceivers.length === 0 ? <Empty title="No receivers connected" /> : (
                <ul className="flex flex-col gap-2 text-sm">{overview.activeReceivers.map((r) => <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"><span>{r.name}<span className="block text-xs text-muted">{r.connection.toLowerCase()}</span></span>{r.tier && <Pill color={TIER_META[r.tier].color}>{TIER_META[r.tier].short}</Pill>}</li>)}</ul>
              )}
            </Card>
            <Card title="AI usage and network">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-muted">AI calls</dt><dd className="num font-display text-xl font-bold">{overview.ai.calls}</dd></div>
                <div><dt className="text-muted">Fallback share</dt><dd className="num font-display text-xl font-bold">{overview.ai.fallbackShare ?? '–'}{overview.ai.fallbackShare != null && '%'}</dd></div>
                <div><dt className="text-muted">Avg bandwidth</dt><dd className="num font-display text-xl font-bold">{overview.network?.bandwidthKbps ?? '–'}<span className="text-xs text-muted"> Kbps</span></dd></div>
                <div><dt className="text-muted">Avg latency</dt><dd className="num font-display text-xl font-bold">{overview.network?.latencyMs ?? '–'}<span className="text-xs text-muted"> ms</span></dd></div>
              </dl>
            </Card>
          </div>
          <Card title="Users"><Users users={users} me={me} reload={loadAll} /></Card>
          <Card title="Audit trail"><Audit /></Card>
        </>
      )}
    </div>
  );
}
