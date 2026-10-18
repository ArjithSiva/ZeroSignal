import { Activity, Flame, Radio, WifiOff } from 'lucide-react';
import { PRESET_NAMES, SCENARIOS, SCENARIO_IDS, metricsFromSlider } from '@zerosignal/shared';
import { SimBadge } from './Badges.jsx';
import { formatKbps } from './SignalLadder.jsx';

const btn = 'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 disabled:opacity-40';

/** Drives the receiver's SIMULATED network. Live Mode swaps the simulator for real measurements. */
export default function SimControls({ control, client, liveSupported = true }) {
  const live = control.live;
  const sliderVal = control.slider ?? 100;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">{live ? 'Measuring this device’s real link to the server.' : 'These controls change a simulated network, not your real one.'}</p>
        {!live && <SimBadge label="Simulated network" />}
      </div>

      <fieldset disabled={live} className="flex flex-col gap-4 disabled:opacity-40">
        <legend className="sr-only">Network presets</legend>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Network presets">
          {PRESET_NAMES.map((p) => {
            const on = control.source === 'preset' && control.preset === p && !control.offline;
            return (
              <button key={p} type="button" aria-pressed={on} onClick={() => client.setPreset(p)} className={`${btn} ${on ? 'border-primary bg-primary/15 text-primary' : 'border-line text-muted hover:text-ink'}`}>
                {p[0] + p.slice(1).toLowerCase()}
              </button>
            );
          })}
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="flex justify-between text-muted">
            <span>Bandwidth slider</span>
            <span className="num font-semibold text-ink">{formatKbps(metricsFromSlider(sliderVal).bandwidthKbps)}</span>
          </span>
          <input type="range" min={0} max={100} value={sliderVal} onChange={(e) => client.setSlider(Number(e.target.value))} className="accent-[var(--color-primary)]" aria-label="Simulated bandwidth, 0 is critical, 100 is excellent" />
        </label>

        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={control.chaos} onClick={() => client.setChaos(!control.chaos)} className={`${btn} inline-flex items-center gap-1.5 ${control.chaos ? 'border-warning bg-warning/15 text-warning' : 'border-line text-muted hover:text-ink'}`}>
            <Flame size={14} aria-hidden /> Chaos
          </button>
          <button type="button" aria-pressed={control.offline} onClick={() => client.setOffline(!control.offline)} className={`${btn} inline-flex items-center gap-1.5 ${control.offline ? 'border-critical bg-critical/15 text-critical' : 'border-line text-muted hover:text-ink'}`}>
            <WifiOff size={14} aria-hidden /> {control.offline ? 'Go online' : 'Go offline'}
          </button>
        </div>

        <div>
          <p className="mb-1.5 text-xs text-muted">Scripted scenarios (per-receiver curves)</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => client.playCurve(null)} className={`${btn} inline-flex items-center gap-1.5 ${control.curveName === 'degrading' ? 'border-primary text-primary' : 'border-line text-muted hover:text-ink'}`}>
              <Activity size={14} aria-hidden /> Degrade over 2 min
            </button>
            {SCENARIO_IDS.map((id) => (
              <button key={id} type="button" onClick={() => client.playCurve(id)} className={`${btn} ${control.curveName === id ? 'border-primary text-primary' : 'border-line text-muted hover:text-ink'}`} title={SCENARIOS[id].tagline}>
                {SCENARIOS[id].title}
              </button>
            ))}
          </div>
        </div>
      </fieldset>

      {liveSupported && (
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-sm">
          <input type="checkbox" checked={live} onChange={(e) => client.setLive(e.target.checked)} className="mt-1 accent-[var(--color-primary)]" />
          <span>
            <span className="flex items-center gap-1.5 font-semibold">
              <Radio size={14} aria-hidden /> Live Mode
            </span>
            <span className="text-muted">Measures real latency, jitter and download speed to the ZeroSignal server. Packet loss is approximated from failed requests, not true packet loss.</span>
          </span>
        </label>
      )}
    </div>
  );
}
