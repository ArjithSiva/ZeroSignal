import crypto from 'node:crypto';

/**
 * Short-lived server-side record of each AI analysis, keyed by an unguessable id.
 * When a broadcaster later sends the message, provenance (Groq vs fallback, whether a human
 * edited the AI output) is taken from THIS record, never from client-supplied claims.
 */
export function createAnalysisCache({ ttlMs = 30 * 60_000, max = 500, now = () => Date.now() } = {}) {
  const map = new Map();
  const sweep = () => {
    const t = now();
    for (const [k, v] of map) if (v.expires <= t) map.delete(k);
    while (map.size > max) map.delete(map.keys().next().value);
  };
  return {
    put(userId, record) {
      sweep();
      const id = crypto.randomBytes(16).toString('hex');
      map.set(id, { userId, record, expires: now() + ttlMs });
      return id;
    },
    /** Returns the record only for the user that created it, and only while fresh. */
    get(id, userId) {
      sweep();
      const v = map.get(id);
      return v && v.userId === userId ? v.record : null;
    },
    size: () => map.size,
  };
}
