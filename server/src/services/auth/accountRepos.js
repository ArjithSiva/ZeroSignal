/**
 * Mongoose implementations of the repository interfaces used by accounts.js.
 * Kept deliberately thin: all business rules live in accounts.js and are unit-tested with in-memory repos.
 */
import mongoose from 'mongoose';
import { AuditLog, AuthToken, RefreshToken, User } from '../../models/index.js';

const SECRET_FIELDS = '+passwordHash +failedLogins +lockedUntil +tokenVersion +totp';
const ms = (d) => (d ? new Date(d).getTime() : null);
const oid = (v) => (v && mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : null);

const userRec = (d) =>
  d && {
    id: String(d._id),
    name: d.name,
    email: d.email,
    role: d.role,
    active: d.active !== false,
    invitePending: Boolean(d.invitePending),
    preferredLanguage: d.preferredLanguage,
    theme: d.theme ?? null,
    phone: d.phone ?? null,
    passwordHash: d.passwordHash,
    failedLogins: d.failedLogins ?? 0,
    lockedUntil: ms(d.lockedUntil),
    tokenVersion: d.tokenVersion ?? 0,
    totp: d.totp ? { enabled: Boolean(d.totp.enabled), secretSealed: d.totp.secretSealed, pendingSealed: d.totp.pendingSealed, lastStep: d.totp.lastStep ?? null, backupHashes: [...(d.totp.backupHashes ?? [])] } : { enabled: false },
    lastLoginAt: ms(d.lastLoginAt),
    createdAt: ms(d.createdAt),
  };

const toDbPatch = (patch) => {
  const p = { ...patch };
  if ('lockedUntil' in p) p.lockedUntil = p.lockedUntil ? new Date(p.lockedUntil) : null;
  if ('lastLoginAt' in p && p.lastLoginAt != null) p.lastLoginAt = new Date(p.lastLoginAt);
  delete p.createdAt;
  return p;
};

export function createMongoAccountRepos() {
  const users = {
    findByEmail: async (email) => userRec(await User.findOne({ email: String(email).toLowerCase() }).select(SECRET_FIELDS).lean()),
    findById: async (id) => (oid(id) ? userRec(await User.findById(oid(id)).select(SECRET_FIELDS).lean()) : null),
    create: async (data) => {
      const { createdAt, ...rest } = data;
      const d = await User.create({ ...toDbPatch(rest) });
      return userRec((await User.findById(d._id).select(SECRET_FIELDS).lean()));
    },
    update: async (id, patch) => (oid(id) ? userRec(await User.findByIdAndUpdate(oid(id), { $set: toDbPatch(patch) }, { new: true }).select(SECRET_FIELDS).lean()) : null),
    list: async ({ limit = 200 } = {}) => (await User.find().sort({ createdAt: 1 }).limit(limit).lean()).map((d) => ({ ...userRec({ ...d, passwordHash: undefined }), passwordHash: undefined })),
  };

  const refresh = {
    create: async (r) => {
      await RefreshToken.create({ familyId: r.familyId, userId: r.userId, tokenHash: r.tokenHash, expiresAt: new Date(r.expiresAt), userAgent: r.userAgent, ip: r.ip });
    },
    findByHash: async (tokenHash) => {
      const d = await RefreshToken.findOne({ tokenHash }).lean();
      return d && { id: String(d._id), familyId: d.familyId, userId: d.userId, expiresAt: ms(d.expiresAt), rotatedAt: ms(d.rotatedAt), revokedAt: ms(d.revokedAt) };
    },
    update: (id, patch) => RefreshToken.updateOne({ _id: id }, { $set: { ...(patch.rotatedAt ? { rotatedAt: new Date(patch.rotatedAt) } : {}) } }),
    revokeFamily: (familyId, at) => RefreshToken.updateMany({ familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(at) } }),
    revokeAllForUser: (userId, at) => RefreshToken.updateMany({ userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(at) } }),
  };

  const authTokens = {
    create: async (t) => {
      await AuthToken.create({ userId: t.userId, purpose: t.purpose, tokenHash: t.tokenHash, expiresAt: new Date(t.expiresAt) });
    },
    findByHash: async (tokenHash, purpose) => {
      const d = await AuthToken.findOne({ tokenHash, purpose }).lean();
      return d && { id: String(d._id), userId: d.userId, purpose: d.purpose, expiresAt: ms(d.expiresAt), usedAt: ms(d.usedAt) };
    },
    markUsed: (id, at) => AuthToken.updateOne({ _id: id }, { $set: { usedAt: new Date(at) } }),
    invalidateForUser: (userId, purpose) => AuthToken.deleteMany({ userId, purpose, usedAt: { $exists: false } }),
  };

  const audit = {
    record: (e) => AuditLog.create({ ...e, at: new Date(e.at) }),
    list: async ({ limit = 100, before, type } = {}) => {
      const q = {};
      if (type) q.type = type;
      if (before) q.at = { $lt: new Date(before) };
      return (await AuditLog.find(q).sort({ at: -1 }).limit(limit).lean()).map((d) => ({ id: String(d._id), type: d.type, at: d.at, actorId: d.actorId ?? null, targetId: d.targetId ?? null, ip: d.ip ?? null, meta: d.meta ?? null }));
    },
  };

  return { users, refresh, authTokens, audit };
}
