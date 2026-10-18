import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

/**
 * LiveKit (WebRTC SFU) provider. The browser publishes ONE simulcast stream (720p/480p/240p layers);
 * the server issues tokens only. Publish and subscribe are separate grants:
 *   publisher  → canPublish, cannot subscribe
 *   viewer     → canSubscribe, cannot publish, no data channel
 * The API secret never leaves the server; the client only ever receives a short-lived signed JWT.
 *
 * `sdk` is injectable so tests can verify grants without network access.
 */
export function createLivekitProvider(cfg, sdk = { AccessToken, RoomServiceClient }) {
  const available = Boolean(cfg.url && cfg.apiKey && cfg.apiSecret);

  const token = async ({ room, identity, name, grants }) => {
    const at = new sdk.AccessToken(cfg.apiKey, cfg.apiSecret, { identity, name, ttl: cfg.tokenTtlSec });
    at.addGrant({ room, roomJoin: true, canPublishData: false, ...grants });
    return at.toJwt();
  };

  return {
    id: 'livekit',
    label: 'LiveKit (WebRTC)',
    available,
    reason: available ? null : 'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not all set',
    layers: ['720p', '480p', '240p', 'AUDIO'],
    async publishCredentials({ room, identity, name }) {
      return { url: cfg.url, token: await token({ room, identity, name, grants: { canPublish: true, canSubscribe: false } }), ttlSec: cfg.tokenTtlSec };
    },
    async viewerCredentials({ room, identity, name }) {
      return { url: cfg.url, token: await token({ room, identity, name, grants: { canPublish: false, canSubscribe: true } }), ttlSec: cfg.tokenTtlSec };
    },
    /** A real reachability probe (lists rooms with the server key). Never throws. */
    async probe(timeoutMs = 3000) {
      if (!available) return { status: 'disabled', note: this.reason };
      try {
        const http = cfg.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        const client = new sdk.RoomServiceClient(http, cfg.apiKey, cfg.apiSecret);
        await Promise.race([client.listRooms(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
        return { status: 'up', note: 'LiveKit reachable with the configured key' };
      } catch (e) {
        return { status: 'down', note: `LiveKit probe failed: ${e.message}` };
      }
    },
    health() {
      return available ? { status: 'configured', note: 'Credentials present; reachability is checked by the probe.' } : { status: 'disabled', note: this.reason };
    },
  };
}
