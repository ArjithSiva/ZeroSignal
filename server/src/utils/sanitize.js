/**
 * Input and output hygiene.
 *
 *  - stripMongoOperators(): NoSQL-injection protection. Removes any key beginning with `$`
 *    or containing `.` from request bodies/queries/params (recursively), so
 *    `{ "email": { "$gt": "" } }` can never reach a Mongoose query as an operator.
 *  - sanitizeText(): used on ALL Groq output (treated as untrusted) and on user text that
 *    will be rendered: removes control chars and HTML tags, collapses whitespace, length-limits.
 */

const FORBIDDEN_KEY = /^\$|\./;

/** Deep-clone `value`, dropping operator-like keys. Arrays and primitives are preserved. */
export function stripMongoOperators(value, depth = 0) {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripMongoOperators(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = stripMongoOperators(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Express middleware: sanitize body, query and params in place. */
export function mongoSanitize(req, _res, next) {
  if (req.body) req.body = stripMongoOperators(req.body);
  if (req.query) {
    const clean = stripMongoOperators({ ...req.query });
    // Express 4 allows reassigning req.query; keep it a plain object.
    req.query = clean;
  }
  if (req.params) req.params = stripMongoOperators({ ...req.params });
  next();
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;
const TAGS = /<\/?[a-z!][^>]*>/gi;

/**
 * @param {unknown} input
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeText(input, maxLen = 2000) {
  if (typeof input !== 'string') return '';
  return input
    .replace(CONTROL_CHARS, '')
    .replace(TAGS, '')
    .replace(/[<>]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLen);
}
