import { layerForTier, normalizeProviderChain } from '@zerosignal/shared';
import { createHlsProvider } from './hls.js';
import { createLivekitProvider } from './livekit.js';
import { roomFor } from './rooms.js';
import { createSimulatedProvider } from './simulated.js';

/**
 * Media service: provider registry, room naming, scoped credentials and the degradation chain.
 * Alerts never depend on it: if every real provider is down the chain still ends in `simulated`, and the
 * text alert path (sockets) is untouched.
 */
export function createMediaService({ config, providers: injected, log = console } = {}) {
  const m = config.media;
  const all = injected ?? {
    livekit: createLivekitProvider(m.livekit),
    hls: createHlsProvider(m.hls, { salt: m.roomSalt, log }),
    simulated: createSimulatedProvider(),
  };
  const chain = normalizeProviderChain(m.providers).filter((id) => all[id]?.available);
  const room = (broadcastId) => roomFor(m.roomSalt, String(broadcastId));

  return {
    providers: all,
    chain,
    room,
    describe() {
      return {
        chain,
        providers: Object.values(all).map((p) => ({ id: p.id, label: p.label, available: p.available, simulated: Boolean(p.simulated), reason: p.reason, layers: p.layers, local: Boolean(p.localServing) })),
        hlsSources: all.hls?.sources?.() ?? null,
      };
    },
    layerFor: layerForTier,

    /** Publish credentials for a single provider (broadcaster/admin only; the route enforces that). */
    async publish({ broadcast, user, provider }) {
      const p = all[provider];
      if (!p?.available) return null;
      const identity = `pub-${user.id}`;
      return { provider: p.id, room: room(broadcast.id), ...(await p.publishCredentials({ room: room(broadcast.id), identity, name: user.name })) };
    },

    /** Subscribe-only credentials for EVERY available provider, in fallback order, so the client can degrade without another round trip. */
    async view({ broadcast, user }) {
      const r = room(broadcast.id);
      const out = [];
      for (const id of chain) {
        const p = all[id];
        if (id === 'hls' && p.status?.(r)?.status !== 'running') continue; // only offer HLS while a ladder is actually being produced
        out.push({ provider: id, simulated: Boolean(p.simulated), ...(await p.viewerCredentials({ room: r, identity: `view-${user.id}`, name: user.name })) });
      }
      return { room: r, chain: out };
    },

    async startHls({ broadcast, kind, source }) {
      if (!all.hls) throw new Error('HLS provider is disabled');
      return all.hls.start(room(broadcast.id), { kind, source });
    },
    async onBroadcastEnded(broadcastId) {
      await all.hls?.stop?.(room(broadcastId));
    },
    statusFor(broadcastId) {
      const j = all.hls?.status?.(room(broadcastId));
      return { hls: j ? { status: j.status, kind: j.kind, error: j.error, startedAt: j.startedAt } : null };
    },
    /** One row for /api/admin/health. Real probes only where cheap; never claims "up" without evidence. */
    async healthAsync() {
      const lk = all.livekit?.probe ? await all.livekit.probe() : null;
      return this.health(lk);
    },
    health(lkProbe = null) {
      const real = chain.filter((c) => c !== 'simulated');
      const primary = real[0] ?? 'simulated';
      const note = real.length
        ? `Chain: ${chain.join(' → ')}. ${all[primary].health().note}${lkProbe ? ` ${lkProbe.note}.` : ''}`
        : 'No real provider configured: viewers get the labelled simulated feed. See the README (LiveKit / HLS).';
      const status = !real.length ? 'degraded' : lkProbe?.status === 'down' ? 'degraded' : 'up';
      return { status, provider: primary, chain, note };
    },
  };
}
