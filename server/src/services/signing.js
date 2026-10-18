/**
 * Alert Integrity — every emergency message is cryptographically signed by the server.
 *
 * DEVIATION FROM THE SPEC (documented in the README): the spec suggests HMAC. HMAC needs a
 * shared secret, and a secret that receivers can use to verify is a secret anyone with a
 * browser can use to forge alerts — it can never be "backend-only". So we use Ed25519:
 * the server signs with a private key that never leaves it; receivers verify with the
 * published PUBLIC key (WebCrypto in the browser, so verification also works offline).
 *
 * What is signed: canonical JSON (sorted keys) of the compact alert payload (< 1 KB).
 */
import crypto from 'node:crypto';
import { buildCompactAlert, canonicalize, compactSize, LANGUAGE_CODES } from '@zerosignal/shared';
import { config } from '../config/env.js';

// PKCS#8 DER prefix for an Ed25519 private key; the 32-byte seed follows.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Derive the Ed25519 key pair deterministically from a 32-byte hex seed. */
export function keyPairFromSeed(seedHex) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  // Raw 32-byte public key = last 32 bytes of the SPKI DER.
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey, publicKeyRaw: spki.subarray(spki.length - 32) };
}

/**
 * @param {string} [seedHex]
 */
export function createSigner(seedHex = config.signingSeed) {
  const { privateKey, publicKey, publicKeyRaw } = keyPairFromSeed(seedHex);
  const publicKeyB64 = publicKeyRaw.toString('base64');

  /** Sign a payload object. @returns {string} base64 signature */
  const sign = (payload) => crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64');

  /** Verify a payload + signature. Never throws. */
  const verify = (payload, signature) => {
    try {
      return crypto.verify(null, Buffer.from(canonicalize(payload), 'utf8'), publicKey, Buffer.from(String(signature), 'base64'));
    } catch {
      return false;
    }
  };

  /**
   * Build + sign compact payloads for every language the message has.
   * @returns {Record<string, { payload: object, signature: string, bytes: number }>}
   */
  const signMessage = (message) => {
    const out = {};
    for (const lang of LANGUAGE_CODES) {
      if (!message.i18n?.[lang]?.summary) continue;
      const payload = buildCompactAlert(message, lang);
      out[lang] = { payload, signature: sign(payload), bytes: compactSize(payload).bytes };
    }
    return out;
  };

  return { sign, verify, signMessage, publicKeyB64, algorithm: 'Ed25519' };
}

let singleton;
/** Lazily-created process-wide signer. */
export const getSigner = () => (singleton ??= createSigner());
