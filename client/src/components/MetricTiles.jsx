import { formatKbps } from './SignalLadder.jsx';

const TILES = [
  ['Bandwidth', (m) => formatKbps(m.bandwidthKbps)],
  ['Latency', (m) => `${Math.round(m.latencyMs)} ms`],
  ['Packet loss', (m) => `${m.packetLoss.toFixed(1)}%`],
  ['Jitter', (m) => `${Math.round(m.jitterMs)} ms`],
  ['Stability', (m) => `${Math.round(m.stability)}`],
];

export default function MetricTiles({ metrics, simulated }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {TILES.map(([label, fmt]) => (
        <div key={label} className="rounded-lg border border-line px-3 py-2">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="num font-display text-base font-bold">{metrics ? fmt(metrics) : '–'}</dd>
        </div>
      ))}
      <p className="col-span-full text-xs text-muted">{metrics ? (simulated ? 'Values come from the simulator.' : 'Values measured on this device’s real link (packet loss is approximated from failed requests).') : 'Waiting for the first reading.'}</p>
    </dl>
  );
}
