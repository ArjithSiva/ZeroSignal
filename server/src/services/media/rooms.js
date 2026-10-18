import crypto from 'node:crypto';

/** Unguessable room name for a broadcast: an HMAC of its id, so knowing a broadcast id never reveals the room. */
export function roomFor(salt, broadcastId) {
  return `zs-${crypto.createHmac('sha256', salt).update(`room:${broadcastId}`).digest('hex').slice(0, 24)}`;
}

/** Short-lived signed path prefix for locally served HLS: `<expSec>.<sig>`. */
export function signHls(salt, room, expSec) {
  const sig = crypto.createHmac('sha256', salt).update(`hls:${room}:${expSec}`).digest('base64url').slice(0, 32);
  return `${expSec}.${sig}`;
}

export function verifyHls(salt, room, prefix, nowSec = Math.floor(Date.now() / 1000)) {
  const [exp, sig] = String(prefix).split('.');
  const expSec = Number(exp);
  if (!Number.isFinite(expSec) || !sig || expSec < nowSec) return false;
  const want = signHls(salt, room, expSec).split('.')[1];
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
