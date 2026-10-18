/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with no dependency. */
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secretB32, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (nowMs, period = 30) => Math.floor(nowMs / 1000 / period);

/**
 * Verify a code within ±`window` steps. Returns the matched step (so callers can reject replays) or null.
 * @returns {number|null}
 */
export function verifyTotp(secretB32, code, { nowMs = Date.now(), window = 1, lastUsedStep = null } = {}) {
  if (!/^\d{6}$/.test(String(code ?? ''))) return null;
  const step = stepOf(nowMs);
  for (let w = -window; w <= window; w++) {
    const s = step + w;
    if (lastUsedStep != null && s <= lastUsedStep) continue; // replay protection
    const expected = hotp(secretB32, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(code)))) return s;
  }
  return null;
}

export const otpauthUri = ({ secret, account, issuer = 'ZeroSignal' }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
