import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalize } from '@zerosignal/shared';

export function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicB64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return {
    publicKey: publicB64,
    signed(payload) {
      return { payload, signature: sign(null, Buffer.from(canonicalize(payload)), privateKey).toString('base64') };
    },
  };
}

export function makeAlert(signer, over = {}) {
  const id = over.id ?? 'a'.repeat(24);
  return {
    id,
    broadcastId: 'b'.repeat(24),
    priority: 'CRITICAL',
    category: 'CYCLONE',
    sentAt: 1_000,
    expiresAt: null,
    zone: null,
    compact: true,
    signed: { en: signer.signed({ v: 1, id, ts: 1, p: 'C', c: 'CYCLONE', l: 'en', h: 'Cyclone: move inland now', a: 'Go to the shelter' }) },
    ...over,
  };
}

export function fakeSocket() {
  const handlers = new Map();
  const sent = [];
  const s = {
    connected: true,
    sent,
    on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
    off: (e, fn) => handlers.set(e, (handlers.get(e) ?? []).filter((f) => f !== fn)),
    connect: () => {},
    emit: (event, data, ack) => {
      sent.push({ event, data });
      const reply = s.replies?.[event]?.(data) ?? { ok: true };
      ack?.(reply);
    },
    trigger: (e, p) => (handlers.get(e) ?? []).forEach((fn) => fn(p)),
    replies: {},
  };
  return s;
}

import { SCENARIOS } from '@zerosignal/shared';
export const findPresetKeys = () => Object.values(SCENARIOS).flatMap((s) => s.messages.map((m) => m.key));
