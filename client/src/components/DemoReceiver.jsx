import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Siren } from 'lucide-react';
import { LANGUAGES } from '@zerosignal/shared';
import { useReceiver } from '../hooks/useReceiver.js';
import { alertText } from '../lib/receiverClient.js';
import { MODE_LABEL, TIER_META } from '../lib/ui.js';
import { Pill, SimBadge } from './Badges.jsx';
import QualityPlayer from './QualityPlayer.jsx';
import ReceiverPanel from './ReceiverPanel.jsx';
import { formatKbps } from './SignalLadder.jsx';
import { tint } from '../lib/theme.js';

/** One of the four simulated demo receivers, on its own socket. */
export default function DemoReceiver({ broadcastId, runTag, spec, language, focused, onFocus, register, initial, slot }) {
  const { client, state } = useReceiver({ broadcastId, id: `${runTag}-${spec.id}`, name: spec.name, language: 'en', location: spec.location, isolated: true, seed: spec.id.charCodeAt(0) });

  useEffect(() => {
    if (!client) return undefined;
    register(spec.id, client, state);
    return () => register(spec.id, null);
    // register once per client; live state is read through snapshots below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (!client || initial == null) return;
    if (typeof initial === 'number') client.setSlider(initial);
    else client.setFixed(initial);
  }, [client, initial]);

  useEffect(() => {
    client?.setLanguage(language);
  }, [client, language]);

  const r = state.receiver;
  const tier = r?.tier ?? null;
  const meta = tier ? TIER_META[tier] : null;
  const latest = state.alerts.find((a) => !a.superseded && a.verification !== 'rejected');
  const text = latest ? alertText(latest, language) : state.cached && !state.cached.tampered ? alertText({ signed: state.cached.signed }, language) : null;
  const critical = latest?.priority === 'CRITICAL';

  return (
    <section aria-label={spec.name} className={`glass flex flex-col gap-2 rounded-2xl p-3 ${focused ? 'ring-1 ring-primary' : ''}`} style={meta ? { borderColor: tint(meta.color, 33) } : undefined}>
      <header className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => onFocus(spec.id)} className="text-left" aria-pressed={focused}>
          <h3 className="font-display text-sm font-bold leading-tight">{spec.name}</h3>
          <p className="num text-xs text-muted">{state.metrics ? formatKbps(state.metrics.bandwidthKbps) : state.status === 'joined' ? 'measuring' : state.status}</p>
        </button>
        {meta && <span className="rounded-md px-2 py-0.5 font-display text-xs font-bold" style={{ background: tint(meta.color, 13), color: meta.color }}>{meta.short}</span>}
      </header>
      <QualityPlayer tier={tier} headline={text?.headline} action={text?.action} cachedLabel="CONNECTION LOST · last verified alert" />
      {critical && (
        <p className="flex items-center gap-1.5 rounded-lg bg-critical/20 px-2 py-1 text-xs font-semibold text-critical" role="status">
          <Siren size={13} aria-hidden /> Critical alert received{latest.simulated ? ' via simulated ' + (latest.channel === 'SMS_SIMULATED' ? 'SMS' : 'mesh') : ''}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {r?.mode && <Pill>{MODE_LABEL[r.mode]}</Pill>}
        <Pill>{LANGUAGES[language]?.native}</Pill>
        <SimBadge label="Simulated link" />
      </div>
      {focused && client && slot && createPortal(<ReceiverPanel client={client} state={state} language={language} takeover={false} media={false} />, slot)}
    </section>
  );
}
