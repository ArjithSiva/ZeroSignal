import { useCallback, useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, Printer, Table2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, Empty, Pill, Spinner } from '../components/Badges.jsx';
import Replay from '../components/Replay.jsx';
import { api, errorMessage } from '../lib/api.js';
import { TIER_META } from '../lib/ui.js';

const AXIS = { stroke: 'var(--color-muted)', fontSize: 11, tickLine: false };
const GRID = 'var(--color-line)';
const TIP = { contentStyle: { background: 'var(--color-surface)', border: '1px solid var(--color-line-strong)', borderRadius: 8, fontSize: 12, color: 'var(--color-ink)' }, labelStyle: { color: 'var(--color-muted)' }, cursor: { stroke: 'var(--color-line-strong)' } };

const pct = (v) => (v == null ? '–' : `${v}%`);
const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDur = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

function Kpi({ label, value, hint }) {
  return (
    <div className="glass rounded-2xl p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="num mt-1 font-display text-3xl font-bold leading-none">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** One measure per chart: no dual axes, one series so the title is the legend, a table view for screen readers. */
function Trend({ title, unit, data, dataKey, color = 'var(--color-primary)' }) {
  const [table, setTable] = useState(false);
  return (
    <Card title={title} action={<button type="button" onClick={() => setTable(!table)} aria-pressed={table} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink"><Table2 size={13} aria-hidden /> Table</button>}>
      {data.length === 0 ? <Empty title="No samples">Network samples appear once receivers have been connected.</Empty> : table ? (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left text-sm"><caption className="sr-only">{title} over time</caption>
            <thead className="text-xs text-muted"><tr><th scope="col" className="py-1">Time</th><th scope="col">{title} ({unit})</th></tr></thead>
            <tbody>{data.map((d) => <tr key={d.t} className="border-t border-line"><td className="num py-1">{fmtT(d.t)}</td><td className="num">{d[dataKey]}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div role="img" aria-label={`${title} over time, ${data.length} points`} className="h-44">
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="t" tickFormatter={fmtT} {...AXIS} minTickGap={36} />
              <YAxis {...AXIS} width={44} />
              <Tooltip {...TIP} labelFormatter={fmtT} formatter={(v) => [`${v} ${unit}`, title]} />
              <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: 'var(--color-surface)', strokeWidth: 2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function Export({ id }) {
  const [busy, setBusy] = useState(false);
  const json = async () => {
    setBusy(true);
    try {
      const { data } = await api.get(`/broadcasts/${id}/report`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `zerosignal-incident-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="no-print flex gap-2">
      <button type="button" disabled={busy} onClick={json} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:border-primary hover:text-primary"><Download size={15} aria-hidden /> Incident report (JSON)</button>
      <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:border-primary hover:text-primary"><Printer size={15} aria-hidden /> Print / save as PDF</button>
    </div>
  );
}

export default function Analytics() {
  const [broadcasts, setBroadcasts] = useState([]);
  const [scope, setScope] = useState('global');
  const [data, setData] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/broadcasts', { params: { limit: 100 } }).then((r) => setBroadcasts(r.data.broadcasts)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setData(null);
    setTimeline(null);
    setError('');
    try {
      const url = scope === 'global' ? '/analytics/global' : `/analytics/broadcasts/${scope}`;
      const [a, t] = await Promise.all([api.get(url), scope === 'global' ? null : api.get(`/broadcasts/${scope}/timeline`)]);
      setData(a.data);
      setTimeline(t?.data ?? null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [scope]);
  useEffect(() => { load(); }, [load]);

  const header = (
    <div className="flex flex-wrap items-end gap-3">
      <div className="mr-auto">
        <h1 className="font-display text-2xl font-bold">Analytics</h1>
        <p className="text-sm text-muted">Everything here is computed from stored data.</p>
      </div>
      <label className="no-print flex flex-col gap-1 text-xs text-muted">Scope
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="min-w-56 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
          <option value="global">All broadcasts</option>
          {broadcasts.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>
      </label>
      {scope !== 'global' && <Export id={scope} />}
    </div>
  );

  if (error) return <div className="flex flex-col gap-4">{header}<Card><p role="alert" className="text-critical">{error}</p><button className="mt-2 text-primary underline" onClick={load}>Try again</button></Card></div>;
  if (!data) return <div className="flex flex-col gap-4">{header}<Spinner label="Crunching the numbers" /></div>;

  const { totals, network, adaptation, quality, delivery, ai, durations, timeline: events } = data;
  const empty = totals.metricSamples === 0 && totals.messages === 0;
  const dist = quality.distribution;
  const pairs = adaptation.headline;

  return (
    <div className="flex flex-col gap-4">
      {header}
      {empty && <Card><Empty title="No data yet">Charts fill in once a broadcast has run with receivers connected.</Empty></Card>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi label="Broadcasts" value={totals.broadcasts} hint={`${totals.liveBroadcasts} live`} />
        <Kpi label="Receivers" value={totals.receivers} hint={`${totals.reconnects} reconnects`} />
        <Kpi label="Alerts sent" value={totals.messages} />
        <Kpi label="Critical delivered" value={pct(delivery.critical.rate)} hint={`${delivery.critical.delivered} of ${delivery.critical.total}${delivery.critical.pending ? ` · ${delivery.critical.pending} pending` : ''}`} />
        <Kpi label="Tier changes" value={adaptation.total} hint={`${pct(adaptation.predictiveShare)} predicted ahead`} />
        <Kpi label="Responses" value={pct(delivery.ackRate)} hint={`${delivery.responses.safe} safe · ${delivery.responses.needHelp} need help`} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Trend title="Bandwidth" unit="Kbps" dataKey="bandwidthKbps" data={network.series} />
        <Trend title="Latency" unit="ms" dataKey="latencyMs" data={network.series} />
        <Trend title="Packet loss" unit="%" dataKey="packetLoss" data={network.series} />
        <Trend title="Jitter" unit="ms" dataKey="jitterMs" data={network.series} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Time spent in each tier">
          <div role="img" aria-label="Share of samples per delivery tier" className="h-56">
            <ResponsiveContainer>
              <BarChart data={dist} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }} barCategoryGap={8}>
                <XAxis type="number" hide domain={[0, 100]} />
                <YAxis type="category" dataKey="tier" {...AXIS} width={56} tickFormatter={(t) => TIER_META[t]?.short ?? t} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--color-line-soft)' }} formatter={(v, _n, p) => [`${v}% (${p.payload.samples} samples)`, 'Share']} />
                <Bar dataKey="share" radius={[0, 4, 4, 0]} barSize={14} isAnimationActive={false} label={{ position: 'right', fill: 'var(--color-muted)', fontSize: 11, formatter: (v) => `${v}%` }}>
                  {dist.map((d) => <Cell key={d.tier} fill={TIER_META[d.tier]?.color ?? 'var(--color-muted)'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Adaptations by step">
          <div role="img" aria-label="Count of tier transitions" className="h-56">
            <ResponsiveContainer>
              <BarChart data={pairs.map((p) => ({ ...p, label: p.key.replace('AUDIO', 'Audio').replace('TEXT', 'Text') }))} margin={{ top: 16, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" {...AXIS} interval={0} />
                <YAxis {...AXIS} allowDecimals={false} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--color-line-soft)' }} formatter={(v) => [v, 'Transitions']} />
                <Bar dataKey="count" fill="var(--color-primary)" radius={[4, 4, 0, 0]} barSize={28} isAnimationActive={false} label={{ position: 'top', fill: 'var(--color-muted)', fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-sm text-muted">{adaptation.reactive} reactive, {adaptation.predictive} predictive. Predictive switches happen before the network fails.</p>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Delivery">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-muted">All alerts</dt><dd className="num font-display text-xl font-bold">{pct(delivery.deliveryRate)}</dd></div>
            <div><dt className="text-muted">Critical</dt><dd className="num font-display text-xl font-bold">{pct(delivery.critical.rate)}</dd></div>
            <div><dt className="text-muted">Expired critical</dt><dd className="num font-display text-xl font-bold">{delivery.critical.expired}</dd></div>
            <div><dt className="text-muted">Pending critical</dt><dd className="num font-display text-xl font-bold">{delivery.critical.pending}</dd></div>
          </dl>
          <p className="mt-3 flex flex-wrap gap-1.5">{Object.entries(delivery.byChannel).map(([c, n]) => <Pill key={c} color={c.endsWith('SIMULATED') ? 'var(--color-warning)' : 'var(--color-primary)'}>{c.replace('_SIMULATED', ' (sim)')}: {n}</Pill>)}</p>
        </Card>
        <Card title="AI usage">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-muted">Calls</dt><dd className="num font-display text-xl font-bold">{ai.calls}</dd></div>
            <div><dt className="text-muted">Fallback share</dt><dd className="num font-display text-xl font-bold">{pct(ai.fallbackShare)}</dd></div>
            <div><dt className="text-muted">Succeeded</dt><dd className="num font-display text-xl font-bold">{ai.succeeded}</dd></div>
            <div><dt className="text-muted">Avg latency</dt><dd className="num font-display text-xl font-bold">{ai.avgLatencyMs} ms</dd></div>
          </dl>
        </Card>
        <Card title="Broadcast duration">
          {durations.length === 0 ? <p className="text-sm text-muted">No broadcast has started yet.</p> : (
            <ul className="flex flex-col gap-1.5 text-sm">{durations.slice(0, 6).map((d) => <li key={d.id} className="flex justify-between gap-2"><span className="truncate">{d.title}</span><span className="num text-muted">{fmtDur(d.durationSec)}</span></li>)}</ul>
          )}
        </Card>
      </div>

      <Card title="Transition timeline">
        {events.length === 0 ? <p className="text-sm text-muted">No tier changes recorded.</p> : (
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-left text-sm"><caption className="sr-only">Tier transitions, newest last</caption>
              <thead className="text-xs text-muted"><tr><th scope="col" className="py-1">Time</th><th scope="col">Receiver</th><th scope="col">Change</th><th scope="col">Trigger</th><th scope="col">Why</th></tr></thead>
              <tbody>
                {[...events].reverse().map((e, i) => (
                  <tr key={i} className="border-t border-line align-top">
                    <td className="num py-1.5 pr-3">{fmtT(e.at)}</td><td className="pr-3">{e.receiverId}</td>
                    <td className="pr-3 font-semibold">{e.from ? `${e.from} → ${e.to}` : e.to}</td>
                    <td className="pr-3">{e.trigger === 'PREDICTIVE' ? <Pill color="var(--color-accent)">Predictive</Pill> : <Pill>Reactive</Pill>}</td>
                    <td className="text-muted">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {timeline && (
        <Card title="Incident replay">
          <Replay timeline={timeline} />
        </Card>
      )}
    </div>
  );
}
