import { useMemo } from 'react';
import { MapPin } from 'lucide-react';
import { TIER_META } from '../lib/ui.js';
import { Empty } from './Badges.jsx';

const W = 640;
const H = 360;
const PAD = 48;
const KM_PER_DEG = 111;

/**
 * A stylised plot of receivers, alert zones and "I'm safe / need help" responses.
 * Deliberately not a tile map: no third-party map service, so it works offline and leaks no locations.
 */
export default function MapView({ receivers, zones = [], acks = [], relays = [] }) {
  const pts = useMemo(() => {
    const list = [
      ...receivers.filter((r) => r.location).map((r) => r.location),
      ...zones.map((z) => ({ lat: z.lat, lng: z.lng })),
      ...acks.filter((a) => a.location).map((a) => a.location),
    ];
    if (!list.length) return null;
    const lats = list.map((p) => p.lat);
    const lngs = list.map((p) => p.lng);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const cos = Math.cos((midLat * Math.PI) / 180);
    const latSpan = Math.max(0.6, Math.max(...lats) - Math.min(...lats));
    const lngSpan = Math.max(0.6, (Math.max(...lngs) - Math.min(...lngs)) * cos);
    const scale = Math.min((W - PAD * 2) / lngSpan, (H - PAD * 2) / latSpan);
    const cLat = midLat;
    const cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    return { scale, cos, project: (p) => [W / 2 + (p.lng - cLng) * cos * scale, H / 2 - (p.lat - cLat) * scale] };
  }, [receivers, zones, acks]);

  if (!pts) return <Empty icon={MapPin} title="No locations yet">Receivers that share a location, and alert zones, appear here.</Empty>;
  const { project, scale, cos } = pts;
  const byId = Object.fromEntries(receivers.map((r) => [r.id, r]));

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-xl border border-line bg-canvas" role="img" aria-label="Map of receivers, alert zones and responses">
        <defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="var(--color-line-soft)" /></pattern></defs>
        <rect width={W} height={H} fill="url(#grid)" />
        {zones.map((z, i) => {
          const [x, y] = project(z);
          const r = (z.radiusKm / KM_PER_DEG) * scale * cos;
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={Math.max(6, (z.radiusKm / KM_PER_DEG) * scale)} fill="rgb(239 68 68 / 0.1)" stroke="var(--color-critical)" strokeDasharray="5 4" />
              <text x={x} y={y - Math.max(6, r) - 6} textAnchor="middle" fontSize="11" fill="var(--color-critical)">{z.label ?? `${z.radiusKm} km zone`}</text>
            </g>
          );
        })}
        {relays.filter((r) => byId[r.from]?.location && byId[r.to]?.location).slice(0, 8).map((r, i) => {
          const [x1, y1] = project(byId[r.from].location);
          const [x2, y2] = project(byId[r.to].location);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-primary)" strokeWidth="2" strokeDasharray="4 3" />;
        })}
        {receivers.filter((r) => r.location).map((r) => {
          const [x, y] = project(r.location);
          const color = r.tier ? TIER_META[r.tier].color : 'var(--color-muted)';
          return (
            <g key={r.id}>
              <circle cx={x} cy={y} r="8" fill={color} stroke="var(--color-canvas)" strokeWidth="2" />
              <text x={x + 12} y={y + 4} fontSize="12" fill="var(--color-ink)">{r.name.split('—')[0].trim()}{r.tier ? ` · ${TIER_META[r.tier].short}` : ''}</text>
            </g>
          );
        })}
        {acks.filter((a) => a.location).map((a, i) => {
          const [x, y] = project(a.location);
          const help = a.status === 'NEED_HELP';
          return (
            <g key={i} transform={`translate(${x + 10},${y - 14})`}>
              <rect width="16" height="16" rx="4" fill={help ? 'var(--color-critical)' : 'var(--color-success)'} />
              <text x="8" y="12" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--color-on-status)">{help ? '!' : '✓'}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1.5 text-xs text-muted">Stylised plot, not a street map. Dashed circle: alert zone. Dashed line: simulated mesh relay. ✓ safe, ! needs help.</figcaption>
    </figure>
  );
}
