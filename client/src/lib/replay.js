/**
 * Incident replay (spec §8.11): rebuild what every receiver, alert and tier change looked like at
 * any moment of a finished broadcast, purely from its stored timeline.
 */
const ms = (v) => (typeof v === 'number' ? v : new Date(v).getTime());

export function timelineBounds(tl) {
  const times = [...(tl.metrics ?? []).map((m) => ms(m.ts)), ...(tl.events ?? []).map((e) => ms(e.at)), ...(tl.messages ?? []).map((m) => ms(m.sentAt)), ...(tl.acks ?? []).map((a) => ms(a.at))].filter(Number.isFinite);
  if (!times.length) return null;
  return { start: Math.min(...times), end: Math.max(...times) };
}

/** @returns {{ receivers: object[], events: object[], messages: object[], acks: object[] }} */
export function stateAt(tl, t) {
  const latest = new Map();
  for (const m of tl.metrics ?? []) {
    const ts = ms(m.ts);
    if (ts > t) continue;
    const cur = latest.get(m.receiverId);
    if (!cur || ts >= cur.ts) latest.set(m.receiverId, { ...m, ts });
  }
  const names = new Map((tl.sessions ?? []).map((s) => [s.receiverId, s.name]));
  const receivers = [...latest.values()]
    .map((m) => ({ id: m.receiverId, name: names.get(m.receiverId) ?? m.receiverId, tier: m.tier ?? null, bandwidthKbps: m.bandwidthKbps, healthScore: m.healthScore ?? null, ts: m.ts }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    receivers,
    events: (tl.events ?? []).filter((e) => ms(e.at) <= t).sort((a, b) => ms(b.at) - ms(a.at)),
    messages: (tl.messages ?? []).filter((m) => ms(m.sentAt) <= t).sort((a, b) => ms(b.sentAt) - ms(a.sentAt)),
    acks: (tl.acks ?? []).filter((a) => ms(a.at) <= t),
  };
}
