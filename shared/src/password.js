/**
 * Password policy shared by the server (authoritative) and the client (live feedback).
 * Length over composition (NIST 800-63B style): minimum length, no trivially common passwords,
 * must not embed the person's own email/name, and some variety so "aaaaaaaaaaaa" is rejected.
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// A short list of the passwords that show up in every breach corpus. Not a substitute for a
// breach-corpus check; it blocks the laziest choices without shipping a large dictionary.
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwerty123', 'qwertyuiop', '1234567890', '123456789',
  '12345678', 'iloveyou', 'admin123', 'welcome1', 'welcome123', 'letmein123', 'monkey123', 'dragon123',
  'abc123456', 'abcd1234', 'qazwsxedc', '1q2w3e4r5t', 'changeme', 'changeme123', 'zerosignal', 'zerosignal1',
  'india123', 'chennai123', 'tamilnadu', 'krishna123', 'sachin10', 'football1', 'baseball1', 'superman1',
  'trustno1', 'princess1', 'sunshine1', 'whatever1', 'internet1', 'computer1', 'starwars1', 'master123',
]);

/**
 * @param {string} password
 * @param {{ email?: string, name?: string }} [identity]
 * @returns {{ ok: boolean, problems: string[], score: number }} score is 0 to 4, for a strength meter
 */
export function validatePassword(password, identity = {}) {
  const pw = typeof password === 'string' ? password : '';
  const problems = [];
  const lower = pw.toLowerCase();

  if (pw.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters.`);
  if (pw.length > PASSWORD_MAX) problems.push(`Use at most ${PASSWORD_MAX} characters.`);
  if (pw && new Set(pw).size < 5) problems.push('Use more varied characters.');
  if (COMMON.has(lower.replace(/[^a-z0-9]/g, ''))) problems.push('That password is too common.');

  const local = String(identity.email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) problems.push('Do not include your email name in your password.');
  for (const part of String(identity.name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) {
      problems.push('Do not include your name in your password.');
      break;
    }
  }

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= PASSWORD_MIN && pw.length < 14 && classes < 2) problems.push('Mix letters with numbers or symbols, or make it 14 characters or longer.');

  let score = 0;
  if (pw.length >= PASSWORD_MIN) score += 1;
  if (pw.length >= 14) score += 1;
  if (classes >= 3) score += 1;
  if (pw.length >= 18 && classes >= 2) score += 1;
  if (problems.length) score = Math.min(score, 1);
  return { ok: problems.length === 0, problems, score };
}
