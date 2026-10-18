import { useState } from 'react';
import { Activity, Archive, Binary, Brain, Network, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { METRIC_SOURCE_LABEL } from '@zerosignal/shared';
import { alertText } from '../lib/receiverClient.js';
import { MODE_LABEL, TIER_META } from '../lib/ui.js';
import AlertList from './AlertList.jsx';
import AlertTakeover from './AlertTakeover.jsx';
import { Card, Pill, SimBadge } from './Badges.jsx';
import CachedAlert from './CachedAlert.jsx';
import DecisionPanel from './DecisionPanel.jsx';
import FeedLog from './FeedLog.jsx';
import MetricTiles from './MetricTiles.jsx';
import PayloadView from './PayloadView.jsx';
import MediaPlayer from './MediaPlayer.jsx';
import ScoreRing from './ScoreRing.jsx';
import SignalLadder from './SignalLadder.jsx';
import SimControls from './SimControls.jsx';

const TABS = [
  ['network', 'Network', Network],
  ['why', 'Why', Brain],
  ['cache', 'Offline', Archive],
  ['payload', 'Payload', Binary],
  ['hops', 'SMS & mesh', Activity],
];

/** The whole receiver experience for one controller. Used by the Receiver page and (compact) by Demo. */
export default function ReceiverPanel({ client, state, language, takeover = true, media = true }) {
  const [tab, setTab] = useState('network');
  const [open, setOpen] = useState(null);
  const r = state.receiver;
  const tier = r?.tier ?? null;
  const offline = tier === 'CACHED';
  const mediaLive = media && state.status === 'joined' && state.broadcast?.status === 'LIVE';
  const latest = state.alerts.find((a) => !a.superseded && a.verification !== 'rejected');
  const shown = latest ? alertText(latest, language) : state.cached && !state.cached.tampered ? alertText({ signed: state.cached.signed }, language) : null;

  const respond = async (id, status) => {
    try {
      await client.respond(id, status);
      toast.success(status === 'SAFE' ? 'Marked safe. The broadcaster can see it.' : 'Help requested. The broadcaster can see it.');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const modal = takeover ? (open ?? state.takeover) : null;
  const active = modal ? (state.alerts.find((a) => a.id === modal.id) ?? modal) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
      <div className="flex flex-col gap-4">
        <Card>
          <MediaPlayer client={client} broadcastId={state.broadcast?.id ?? state.broadcast?._id} live={mediaLive} tier={tier} layer={r?.layer ?? null} headline={shown?.headline} action={shown?.action} cachedLabel={offline ? 'No signal · showing the last verified alert' : undefined} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {tier && <Pill color={TIER_META[tier].color}>{TIER_META[tier].label}</Pill>}
            {r?.mode && <Pill>{MODE_LABEL[r.mode]}</Pill>}
            {state.simulated ? <SimBadge label="Simulated network" /> : <Pill color="var(--color-success)" title="Where the numbers feeding the adaptive engine come from">{METRIC_SOURCE_LABEL[state.metricSource] ?? 'Live measurement'}</Pill>}
            {state.control.chaos && <Pill color="var(--color-warning)">Chaos on</Pill>}
            {offline && (
              <Pill color="var(--color-critical)"><WifiOff size={12} aria-hidden /> Offline</Pill>
            )}
          </div>
        </Card>
        <Card title="Alerts">
          <AlertList alerts={state.alerts} language={language} onOpen={(a) => setOpen(a)} />
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <SignalLadder tier={tier} bandwidthKbps={state.metrics?.bandwidthKbps} compact />
            <div className="flex flex-col gap-3">
              <ScoreRing score={r?.health?.score} label={r?.health?.label} caption="Signal health" size={96} />
              <ScoreRing score={r?.quality?.score} label={r?.quality?.label} caption="Broadcast quality" size={96} />
            </div>
          </div>
        </Card>
        <Card>
          <div role="tablist" aria-label="Receiver details" className="mb-3 flex gap-1 overflow-x-auto">
            {TABS.map(([id, label, Icon]) => (
              <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => setTab(id)} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${tab === id ? 'bg-primary/15 text-primary' : 'text-muted hover:text-ink'}`}>
                <Icon size={14} aria-hidden /> {label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'network' && (
              <div className="flex flex-col gap-4">
                <MetricTiles metrics={state.metrics} simulated={state.simulated} />
                <SimControls control={state.control} client={client} />
              </div>
            )}
            {tab === 'why' && (
              <div className="flex flex-col gap-3">
                <DecisionPanel receiver={r} events={state.events} metrics={state.metrics} />
                <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                  <input type="checkbox" checked={state.autoPreempt} onChange={(e) => client.setAutoPreempt(e.target.checked)} className="accent-[var(--color-primary)]" />
                  Switch ahead of a predicted drop (turn off to see purely reactive behaviour)
                </label>
              </div>
            )}
            {tab === 'cache' && <CachedAlert cached={state.cached} language={language} offline={offline} onTamper={state.cached ? () => client.tamperCache() : null} />}
            {tab === 'payload' && <PayloadView alert={latest} language={language} kbps={state.metrics?.bandwidthKbps} tierSeconds={state.tierSeconds} />}
            {tab === 'hops' && <FeedLog feed={state.feed} selfId={state.id} />}
          </div>
        </Card>
      </div>

      <AlertTakeover
        alert={active}
        language={language}
        response={active ? state.responded[active.id] : null}
        onRespond={(s) => respond(active.id, s)}
        onDismiss={() => {
          setOpen(null);
          client.dismissTakeover();
        }}
      />
    </div>
  );
}
