import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Bot, Globe, Play, RotateCcw, Siren, Square, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { DEMO_RECEIVERS, LANGUAGE_CODES, LANGUAGES, allScenarioMessages } from '@zerosignal/shared';
import ActivityLog from '../components/ActivityLog.jsx';
import { Card, Pill, SimBadge } from '../components/Badges.jsx';
import DemoReceiver from '../components/DemoReceiver.jsx';
import MessageFeed from '../components/MessageFeed.jsx';
import { useOps } from '../hooks/useOps.js';
import { api, errorMessage } from '../lib/api.js';
import { AUTOPILOT, AUTOPILOT_SECONDS, RECEIVER_IDS, SPEC_CONDITIONS } from '../lib/demoScript.js';

const PRESET_MSGS = Object.fromEntries(allScenarioMessages().map((m) => [m.key, m]));
const btn = 'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40';
const idle = 'border-line text-muted hover:border-primary hover:text-primary';

export default function Demo() {
  const nav = useNavigate();
  const [broadcast, setBroadcast] = useState(null);
  const [mode, setMode] = useState('manual'); // manual | autopilot
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState('en');
  const [target, setTarget] = useState('C');
  const [focus, setFocus] = useState('C');
  const [slot, setSlot] = useState(null);
  const [caption, setCaption] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [showSummary, setShowSummary] = useState(false);

  // Receiver ids on the wire are namespaced per page session, so two people (or two tabs) running the demo never collide.
  const [runTag, setRunTag] = useState(() => Math.random().toString(36).slice(2, 8));
  const clients = useRef({});
  const startedAt = useRef(0);
  const fired = useRef(new Set());
  const broadcastRef = useRef(null);
  broadcastRef.current = broadcast;

  const ops = useOps(broadcast?.id);

  const register = useCallback((id, client) => {
    if (client) clients.current[id] = client;
    else delete clients.current[id];
  }, []);

  const ready = () => RECEIVER_IDS.every((id) => clients.current[id]?.getSnapshot().status === 'joined');

  // ───────── lifecycle ─────────
  const startDemo = async (kind) => {
    if (broadcastRef.current) return broadcastRef.current;
    setBusy(true);
    try {
      const { data } = await api.post('/broadcasts', { title: `Simulated-receiver run · ${new Date().toLocaleTimeString()}`, description: 'Created from the Demo page. Four simulated receivers; the network conditions are simulated.', scenarioId: 'cyclone' });
      await api.post(`/broadcasts/${data.broadcast.id}/start`);
      setMode(kind);
      setBroadcast(data.broadcast);
      broadcastRef.current = data.broadcast;
      return data.broadcast;
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const stopAutopilot = useCallback(() => {
    setRunning(false);
  }, []);

  const reset = async () => {
    stopAutopilot();
    // Reset only clears the in-memory scenario (receivers, captions, timers). The live broadcast is kept
    // and reused; it ends when this page is left.
    clients.current = {};
    setRunTag(Math.random().toString(36).slice(2, 8));
    fired.current = new Set();
    setCaption('');
    setElapsed(0);
    setAnalysis(null);
    setShowSummary(false);
    setLanguage('en');
    setMode('manual');
    toast.success('Scenario reset. Receivers restart from their opening conditions.');
  };

  // End the demo broadcast if the page is left, so it does not linger as LIVE.
  useEffect(
    () => () => {
      const b = broadcastRef.current;
      if (b) api.post(`/broadcasts/${b.id}/stop`).catch(() => {});
    },
    [],
  );

  // ───────── scripted controls ─────────
  const net = (kind) => {
    const c = clients.current[target];
    if (!c) return toast.error('Start the demo first');
    if (kind === 'excellent') c.setPreset('EXCELLENT');
    if (kind === 'degrading') c.playCurve(null);
    if (kind === 'critical') c.setPreset('CRITICAL');
    if (kind === 'offline') c.setPreset('OFFLINE');
    setFocus(target);
  };

  const analyze = async (key) => {
    try {
      const { data } = await api.post('/emergency/analyze', { text: PRESET_MSGS[key].raw });
      setAnalysis(data);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const emergency = async (key = 'cyclone-landfall', zoned = false) => {
    const b = broadcastRef.current;
    const p = PRESET_MSGS[key];
    if (!b || !p) return false;
    try {
      const { data } = await api.post('/emergency', {
        broadcastId: b.id,
        original: p.raw,
        priority: p.priority,
        category: p.category,
        summary: p.i18n.en.summary,
        recommendedAction: p.i18n.en.action,
        presetKey: key,
        expiresInMinutes: 360,
        ...(zoned && p.zone ? { zone: { lat: p.zone.lat, lng: p.zone.lng, radiusKm: p.zone.radiusKm, label: p.zone.label } } : {}),
      });
      toast.success(`Alert sent to ${data.dispatch.targeted} of ${data.dispatch.receivers} receivers`);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };

  const cycleLanguage = () => setLanguage((l) => LANGUAGE_CODES[(LANGUAGE_CODES.indexOf(l) + 1) % LANGUAGE_CODES.length]);

  // ───────── auto-pilot ─────────
  const perform = async (a) => {
    if (a.type === 'start') {
      const b = await startDemo('autopilot');
      return Boolean(b);
    }
    if (!ready()) return false;
    switch (a.type) {
      case 'curves':
        RECEIVER_IDS.forEach((id) => clients.current[id].playCurve(a.scenario));
        return true;
      case 'analyze':
        analyze(a.preset);
        return true;
      case 'emergency':
        return emergency(a.preset);
      case 'language':
        setLanguage(a.lang);
        return true;
      case 'offline':
        clients.current[a.id].setPreset('OFFLINE');
        setFocus(a.id);
        return true;
      case 'online':
        clients.current[a.id].setPreset('GOOD');
        return true;
      case 'summary':
        setShowSummary(true);
        return true;
      default:
        return true;
    }
  };

  const startAutopilot = () => {
    fired.current = new Set();
    startedAt.current = Date.now();
    setElapsed(0);
    setShowSummary(false);
    setRunning(true);
  };

  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(async () => {
      const sec = (Date.now() - startedAt.current) / 1000;
      setElapsed(sec);
      for (const [i, step] of AUTOPILOT.entries()) {
        if (step.at > sec || fired.current.has(i)) continue;
        fired.current.add(i); // claim first so a slow action cannot fire twice
        setCaption(step.caption);
        for (const a of step.actions ?? []) {
          const ok = await perform(a);
          if (!ok) {
            fired.current.delete(i); // not ready yet (receivers still joining): retry next tick
            break;
          }
        }
      }
      if (sec >= AUTOPILOT_SECONDS) setRunning(false);
    }, 400);
    return () => clearInterval(t);
    // perform reads refs and stable setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // ───────── summary (computed from live data, never asserted) ─────────
  const summary = useMemo(() => {
    const crit = Object.values(ops.messages).filter((m) => m.priority === 'CRITICAL');
    let total = 0;
    let ok = 0;
    for (const m of crit) {
      for (const d of Object.values(ops.deliveries[m.id] ?? {})) {
        total += 1;
        if (d.status === 'DELIVERED' || d.status === 'ACKED') ok += 1;
      }
    }
    return {
      receivers: Object.keys(ops.receivers).length,
      adaptations: ops.events.length,
      predictive: ops.events.filter((e) => e.trigger === 'PREDICTIVE').length,
      critical: crit.length,
      criticalDelivered: ok,
      criticalTotal: total,
      responses: ops.acks.length,
    };
  }, [ops.messages, ops.deliveries, ops.receivers, ops.events, ops.acks]);

  const live = Boolean(broadcast);

  // Command palette / keyboard shortcuts drive the page through one window event.
  const actions = useRef({});
  actions.current = {
    start: () => !broadcastRef.current && startDemo('manual'),
    autopilot: async () => { if (await startDemo('autopilot')) startAutopilot(); },
    emergency: () => (broadcastRef.current ? emergency() : toast.error('Start the demo first')),
    translate: cycleLanguage,
    reset,
  };
  useEffect(() => {
    const on = (e) => actions.current[e.detail]?.();
    window.addEventListener('zs:demo', on);
    return () => window.removeEventListener('zs:demo', on);
  }, []);
  const spec = (r) => ({ ...r });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="font-display text-2xl font-bold">Demo mode</h1>
          <p className="text-sm text-muted">Four simulated receivers and one broadcaster, running the real system. Only the network conditions are simulated.</p>
        </div>
        {!live && (
          <>
            <button type="button" disabled={busy} onClick={() => startDemo('manual')} className={`${btn} border-primary bg-primary/15 text-primary`}><Play size={16} aria-hidden /> Start demo</button>
            <button type="button" disabled={busy} onClick={async () => { if (await startDemo('autopilot')) startAutopilot(); }} className={`${btn} ${idle}`}><Bot size={16} aria-hidden /> Auto-pilot (3.5 min)</button>
          </>
        )}
        {live && !running && mode !== 'autopilot' && (
          <button type="button" onClick={startAutopilot} className={`${btn} ${idle}`}><Bot size={16} aria-hidden /> Run auto-pilot</button>
        )}
        {running && <button type="button" onClick={stopAutopilot} className={`${btn} border-warning text-warning`}><Square size={15} aria-hidden /> Stop auto-pilot</button>}
        {live && <button type="button" onClick={reset} className={`${btn} border-critical/50 text-critical`}><RotateCcw size={15} aria-hidden /> Reset</button>}
      </div>

      {(caption || running) && (
        <div role="status" aria-live="polite" className="glass rounded-2xl border-primary/40 p-4">
          <p className="font-display text-lg font-semibold leading-snug sm:text-xl">{caption || 'Starting…'}</p>
          <div className="mt-3 h-1 overflow-hidden rounded bg-line" aria-hidden>
            <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${Math.min(100, (elapsed / AUTOPILOT_SECONDS) * 100)}%` }} />
          </div>
        </div>
      )}

      {live && (
        <Card className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted">Apply network to
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-ink">
              {DEMO_RECEIVERS.map((r) => <option key={r.id} value={r.id}>Receiver {r.id}</option>)}
            </select>
          </label>
          <button type="button" className={`${btn} ${idle}`} onClick={() => net('excellent')}>Excellent</button>
          <button type="button" className={`${btn} ${idle}`} onClick={() => net('degrading')}>Degrading</button>
          <button type="button" className={`${btn} ${idle}`} onClick={() => net('critical')}>Critical</button>
          <button type="button" className={`${btn} ${idle}`} onClick={() => net('offline')}>Offline</button>
          <span className="mx-1 hidden h-6 w-px bg-line sm:block" />
          <button type="button" className={`${btn} border-critical/50 text-critical hover:bg-critical/10`} onClick={() => emergency()}><Siren size={15} aria-hidden /> Trigger emergency</button>
          <button type="button" className={`${btn} ${idle}`} onClick={() => emergency('cyclone-landfall', true)} title="Only receivers inside the Nagapattinam zone get it (C and D)"><Zap size={15} aria-hidden /> Zoned emergency</button>
          <button type="button" className={`${btn} ${idle}`} onClick={cycleLanguage}><Globe size={15} aria-hidden /> Translate: {LANGUAGES[language].native}</button>
          <button type="button" className={`${btn} ${idle}`} onClick={() => setShowSummary((s) => !s)}><BarChart3 size={15} aria-hidden /> Show analytics</button>
        </Card>
      )}

      {!live && (
        <Card>
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            <strong className="text-ink">Start demo</strong> goes live with receivers at the spec’s conditions: A above 8 Mbps (720p), B about 2 Mbps (480p), C 80 Kbps (text), D a healthy neighbour of C for the mesh relay. <strong className="text-ink">Auto-pilot</strong> runs the whole story with captions. <strong className="text-ink">Reset</strong> restarts the simulated receivers and clears the screen; it does not touch any stored data.
          </p>
          <p className="mt-3"><SimBadge label="Network conditions are simulated" /></p>
        </Card>
      )}

      {live && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {DEMO_RECEIVERS.map((r) => (
              <DemoReceiver
                key={`${broadcast.id}-${runTag}-${r.id}`}
                broadcastId={broadcast.id}
                runTag={runTag}
                spec={spec(r)}
                language={language}
                focused={focus === r.id}
                onFocus={setFocus}
                register={register}
                slot={slot}
                initial={mode === 'autopilot' ? 100 : SPEC_CONDITIONS[r.id]}
              />
            ))}
          </div>
          <div ref={setSlot} />

          {showSummary && (
            <Card title="What the system measured (from live data)">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ['Receivers', summary.receivers],
                  ['Tier changes', summary.adaptations],
                  ['Predictive', summary.predictive],
                  ['Critical alerts', summary.critical],
                  ['Critical delivered', summary.criticalTotal ? `${summary.criticalDelivered}/${summary.criticalTotal}` : '–'],
                  ['Responses', summary.responses],
                ].map(([l, v]) => (
                  <div key={l} className="rounded-lg border border-line p-3"><dt className="text-xs text-muted">{l}</dt><dd className="num font-display text-2xl font-bold">{v}</dd></div>
                ))}
              </dl>
              <button type="button" onClick={() => nav('/analytics')} className="mt-3 text-sm text-primary underline">Open full analytics</button>
            </Card>
          )}

          {analysis && (
            <Card title="AI analysis of the announcement (for human review)">
              <div className="flex flex-wrap items-center gap-2">
                <Pill color={analysis.meta.fallback ? 'var(--color-warning)' : 'var(--color-accent)'}><Bot size={12} aria-hidden /> {analysis.meta.fallback ? 'Rule-based fallback' : `AI · ${analysis.meta.model}`}</Pill>
                <Pill color="var(--color-critical)">{analysis.analysis.priority}</Pill>
                <Pill>{analysis.analysis.category}</Pill>
                {analysis.analysis.confidence != null && <Pill>Confidence {Math.round(analysis.analysis.confidence * 100)}%</Pill>}
              </div>
              <p className="mt-2 font-display font-semibold">{analysis.analysis.summary}</p>
              <p className="text-sm text-muted">{analysis.analysis.recommendedAction}</p>
              {analysis.meta.fallback && <p className="mt-1 text-xs text-warning">{analysis.meta.reason}</p>}
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Broadcaster view: delivery"><MessageFeed messages={ops.messages} deliveries={ops.deliveries} receivers={ops.receivers} acks={ops.acks} /></Card>
            <Card title="Broadcaster view: live activity"><ActivityLog events={ops.events} acks={ops.acks} relays={ops.relays} receivers={ops.receivers} /></Card>
          </div>
        </>
      )}
    </div>
  );
}
