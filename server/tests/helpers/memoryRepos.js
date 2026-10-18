/** In-memory implementations of the account repository interfaces (tests only). */
import { newId } from '../../src/services/auth/tokens.js';

export function createMemoryRepos() {
  const state = { users: new Map(), refresh: new Map(), authTokens: new Map(), audit: [] };
  const clone = (o) => (o ? structuredClone(o) : o);

  const users = {
    findByEmail: async (email) => clone([...state.users.values()].find((u) => u.email === String(email).toLowerCase())) ?? null,
    findById: async (id) => clone(state.users.get(id)) ?? null,
    create: async (data) => {
      const rec = { id: newId(), tokenVersion: 0, ...clone(data), email: String(data.email).toLowerCase() };
      state.users.set(rec.id, rec);
      return clone(rec);
    },
    update: async (id, patch) => {
      const cur = state.users.get(id);
      if (!cur) return null;
      Object.assign(cur, clone(patch));
      return clone(cur);
    },
    list: async () => [...state.users.values()].map(clone),
  };

  const refresh = {
    create: async (r) => void state.refresh.set(r.id, clone(r)),
    findByHash: async (h) => clone([...state.refresh.values()].find((r) => r.tokenHash === h)) ?? null,
    update: async (id, patch) => void Object.assign(state.refresh.get(id), patch),
    revokeFamily: async (familyId, at) => void [...state.refresh.values()].filter((r) => r.familyId === familyId && !r.revokedAt).forEach((r) => (r.revokedAt = at)),
    revokeAllForUser: async (userId, at) => void [...state.refresh.values()].filter((r) => r.userId === userId && !r.revokedAt).forEach((r) => (r.revokedAt = at)),
  };

  const authTokens = {
    create: async (t) => void state.authTokens.set(t.id, clone(t)),
    findByHash: async (h, purpose) => clone([...state.authTokens.values()].find((t) => t.tokenHash === h && t.purpose === purpose)) ?? null,
    markUsed: async (id, at) => void (state.authTokens.get(id).usedAt = at),
    invalidateForUser: async (userId, purpose) => void [...state.authTokens.entries()].filter(([, t]) => t.userId === userId && t.purpose === purpose && !t.usedAt).forEach(([k]) => state.authTokens.delete(k)),
  };

  const audit = {
    record: async (e) => void state.audit.push(clone(e)),
    list: async ({ limit = 100 } = {}) => state.audit.slice(-limit).reverse(),
  };

  return { state, repos: { users, refresh, authTokens, audit } };
}
