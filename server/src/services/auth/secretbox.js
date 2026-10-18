/** AES-256-GCM for small secrets at rest (TOTP seeds). Key is derived from the server's JWT secret via HKDF. */
import crypto from 'node:crypto';

const key = (secret) => Buffer.from(crypto.hkdfSync('sha256', secret, 'zerosignal-secretbox', 'v1', 32));

export function seal(plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function open(sealed, secret) {
  const [v, iv, tag, ct] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Bad sealed value');
  const d = crypto.createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
