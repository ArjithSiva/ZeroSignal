/**
 * Password hashing and policy.
 *  - New hashes are argon2id (OWASP baseline parameters, configurable).
 *  - Legacy bcrypt hashes still verify and are transparently upgraded on the next successful login.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', '123456789', '1234567890', '12345678910', 'qwertyuiop', 'qwerty123', 'iloveyou1', 'letmein123', 'welcome123',
  'admin12345', 'administrator', 'changeme123', 'zerosignal', 'zerosignal1', 'abcd123456', 'india12345', 'chennai123', 'tamilnadu1',
]);

/**
 * @returns {string[]} human-readable problems; empty = acceptable
 */
export function checkPasswordPolicy(password, { email = '', name = '' } = {}) {
  const problems = [];
  const p = String(password ?? '');
  if (p.length < 10) problems.push('Use at least 10 characters.');
  if (p.length > 128) problems.push('Use at most 128 characters.');
  const lower = p.toLowerCase();
  if (COMMON.has(lower.replace(/[^a-z0-9]/g, ''))) problems.push('That password is too common.');
  if (/^(.)\1+$/.test(p)) problems.push('Do not repeat a single character.');
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) problems.push('Do not include your email name.');
  const first = name.trim().split(/\s+/)[0]?.toLowerCase();
  if (first && first.length >= 4 && lower.includes(first)) problems.push('Do not include your name.');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  if (classes < 2 && p.length < 16) problems.push('Mix letters with digits or symbols, or use a longer passphrase (16+ characters).');
  return problems;
}

/** A random password that always satisfies the policy (for CLI seeding). */
export function generatePassword(len = 18) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 6)}-${s.slice(6, 12)}-${s.slice(12)}9a`;
}

export function createHasher({ memoryCost = 19_456, timeCost = 2, parallelism = 1 } = {}) {
  return {
    async hash(password) {
      return argonHash(password, { memoryCost, timeCost, parallelism, algorithm: 2 /* argon2id */ });
    },
    /** @returns {Promise<{ ok: boolean, needsRehash: boolean }>} */
    async verify(hash, password) {
      if (!hash) return { ok: false, needsRehash: false };
      try {
        if (hash.startsWith('$argon2')) return { ok: await argonVerify(hash, password), needsRehash: false };
        if (hash.startsWith('$2')) return { ok: await bcrypt.compare(password, hash), needsRehash: true };
      } catch {
        /* malformed hash */
      }
      return { ok: false, needsRehash: false };
    },
  };
}
