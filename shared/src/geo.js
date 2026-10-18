/** Geo helpers for zone-targeted alerts and simulated mesh range. Pure. */

const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km between two {lat, lng} points. */
export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/**
 * Is a receiver inside an alert zone? No zone means "everyone"; a zone with a receiver
 * whose location is unknown means "not targeted" (we never guess).
 * @param {{ lat:number, lng:number }|null|undefined} location
 * @param {{ lat:number, lng:number, radiusKm:number }|null|undefined} zone
 */
export function inZone(location, zone) {
  if (!zone || !validPoint(zone) || !(zone.radiusKm > 0)) return true;
  if (!validPoint(location)) return false;
  return haversineKm(location, zone) <= zone.radiusKm;
}

/** Simulated mesh radio range (Wi-Fi Direct / BLE class) — a deliberately short hop. */
export const MESH_RANGE_KM = 1;
