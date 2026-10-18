/**
 * Account service: registration, sign-in, sessions, password lifecycle, invites, 2FA.
 *
 * All persistence goes through small repository interfaces (see accountRepos.js for the Mongoose
 * implementation and tests/helpers/memoryRepos.js for the in-memory one), so every rule here —
 * lockout, rotation, reuse detection, reset tokens — is unit-tested without a database.
 *
 * Sessions: a short-lived HS256 access JWT (kept in memory by the client) plus an opaque,
 * rotating refresh token (httpOnly cookie, stored only as a sha256). Re-presenting a rotated
 * refresh token outside a short grace window revokes the whole token family.
 */
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../utils/errors.js';
import { signToken } from '../../middleware/auth.js';
import { checkPasswordPolicy } from './passwords.js';
import { hashToken, newId, newOpaqueToken } from './tokens.js';
import { generateSecret, otpauthUri, verifyTotp } from './totp.js';
import { open, seal } from './secretbox.js';

export const ROLES = ['admin', 'broadcaster', 'receiver'];
const STAFF = new Set(['admin', 'broadcaster']);
const ROTATION_GRACE_MS = 10_000;
const MIN = 60_000;

const lockedError = (until, now) => {
  const retryAfterSec = Math.max(1, Math.ceil((until - now) / 1000));
  const e = new AppError(429, `Too many failed attempts. Try again in ${retryAfterSec < 90 ? `${retryAfterSec} seconds` : `${Math.ceil(retryAfterSec / 60)} minutes`}.`, 'ACCOUNT_LOCKED', { retryAfterSec });
  return e;
};

/**
 * @param {object} deps
 * @param {{ users: any, refresh: any, authTokens: any, audit: any }} deps.repos
 * @param {ReturnType<typeof import('../../config/env.js').loadConfig>} deps.config
 * @param {{ send: Function }} deps.mailer
 * @param {{ hash: Function, verify: Function }} deps.hasher
 * @param {() => number} [deps.now]
 */
export function createAccountService({ repos, config, mailer, hasher, now = () => Date.now() }) {
  const { users, refresh, authTokens, audit } = repos;
  const A = config.auth;
  const secret = config.jwtSecret;
  // Hashed once at startup: compared against when an email is unknown so timing does not reveal which emails exist.
  let dummyHash;
  const getDummy = async () => (dummyHash ??= await hasher.hash('not-a-real-password'));

  const view = (u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    preferredLanguage: u.preferredLanguage ?? 'en',
    theme: u.theme ?? null,
    twoFactorEnabled: Boolean(u.totp?.enabled),
    twoFactorAvailable: STAFF.has(u.role),
  });

  const log = (type, ctx = {}, extra = {}) =>
    audit.record({ type, at: now(), ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, actorId: ctx.actorId ?? extra.targetId ?? null, targetId: extra.targetId ?? null, meta: extra.meta ?? null }).catch(() => {});

  async function issueSession(user, ctx, familyId = newId()) {
    const token = newOpaqueToken();
    const expiresAt = now() + A.refreshTtlDays * 86_400_000;
    await refresh.create({ id: newId(), familyId, userId: user.id, tokenHash: hashToken(token), expiresAt, createdAt: now(), userAgent: ctx?.userAgent?.slice(0, 200) ?? null, ip: ctx?.ip ?? null });
    const accessToken = signToken({ _id: user.id, role: user.role, name: user.name, email: user.email }, config);
    return { user: view(user), accessToken, refreshToken: token, refreshExpiresAt: expiresAt };
  }

  async function registerFailure(user, ctx) {
    if (!user) return;
    const failedLogins = (user.failedLogins ?? 0) + 1;
    const patch = { failedLogins };
    if (failedLogins >= A.lockout.threshold) {
      const minutes = Math.min(A.lockout.maxMinutes, A.lockout.baseMinutes * 2 ** (failedLogins - A.lockout.threshold));
      patch.lockedUntil = now() + minutes * MIN;
      await log('LOGIN_LOCKED', ctx, { targetId: user.id, meta: { minutes } });
    }
    await users.update(user.id, patch);
    await log('LOGIN_FAILED', ctx, { targetId: user.id });
  }

  function requireAcceptable(password, user) {
    const problems = checkPasswordPolicy(password, user);
    if (problems.length) throw badRequest('That password is not strong enough.', problems.map((message) => ({ path: 'password', message })));
  }

  const mailLink = (path, token) => `${config.appBaseUrl}${path}?token=${encodeURIComponent(token)}`;

  return {
    view,

    // ───────────── registration & sign-in ─────────────
    async register({ name, email, password, phone, location, language }, ctx = {}) {
      requireAcceptable(password, { email, name });
      if (await users.findByEmail(email)) throw conflict('An account with that email already exists. Sign in, or use “Forgot password”.');
      const user = await users.create({
        name, email, role: 'receiver', passwordHash: await hasher.hash(password), active: true, preferredLanguage: language ?? 'en', phone: phone ?? null, location: location ?? null,
        failedLogins: 0, lockedUntil: null, totp: { enabled: false }, createdAt: now(),
      });
      await log('REGISTER', ctx, { targetId: user.id });
      return issueSession(user, ctx);
    },

    async login({ email, password, totp }, ctx = {}) {
      const user = await users.findByEmail(email);
      if (user?.lockedUntil && user.lockedUntil > now()) {
        await log('LOGIN_BLOCKED', ctx, { targetId: user.id });
        throw lockedError(user.lockedUntil, now());
      }
      const { ok, needsRehash } = await hasher.verify(user?.passwordHash ?? (await getDummy()), password);
      if (!user || !ok || !user.active) {
        await registerFailure(user, ctx);
        throw unauthorized('Incorrect email or password');
      }

      let patch = {};
      if (user.totp?.enabled) {
        if (!totp) throw new AppError(401, 'Enter the 6-digit code from your authenticator app.', 'TOTP_REQUIRED');
        const code = String(totp).trim();
        const step = verifyTotp(open(user.totp.secretSealed, secret), code, { nowMs: now(), lastUsedStep: user.totp.lastStep ?? null });
        if (step != null) patch = { totp: { ...user.totp, lastStep: step } };
        else {
          const h = hashToken(code.replace(/\s/g, '').toLowerCase());
          const backups = user.totp.backupHashes ?? [];
          if (!backups.includes(h)) {
            await registerFailure(user, ctx);
            throw unauthorized('That authentication code is not valid.');
          }
          patch = { totp: { ...user.totp, backupHashes: backups.filter((x) => x !== h) } };
          await log('BACKUP_CODE_USED', ctx, { targetId: user.id });
        }
      }

      patch = { ...patch, failedLogins: 0, lockedUntil: null, lastLoginAt: now() };
      if (needsRehash) patch.passwordHash = await hasher.hash(password);
      const updated = await users.update(user.id, patch);
      await log('LOGIN_SUCCESS', ctx, { targetId: user.id });
      return issueSession(updated, ctx);
    },

    // ───────────── sessions ─────────────
    async refresh(token, ctx = {}) {
      if (!token) throw unauthorized('No session');
      const rec = await refresh.findByHash(hashToken(token));
      if (!rec || rec.revokedAt || rec.expiresAt <= now()) throw unauthorized('Session expired');
      if (rec.rotatedAt) {
        if (now() - rec.rotatedAt > ROTATION_GRACE_MS) {
          // A retired token came back: assume theft and end the whole family.
          await refresh.revokeFamily(rec.familyId, now());
          await log('TOKEN_REUSE_DETECTED', ctx, { targetId: rec.userId });
          throw unauthorized('Session expired');
        }
      }
      const user = await users.findById(rec.userId);
      if (!user || !user.active) throw unauthorized('Session expired');
      const session = await issueSession(user, ctx, rec.familyId);
      if (!rec.rotatedAt) await refresh.update(rec.id, { rotatedAt: now() });
      return session;
    },

    async logout(token, ctx = {}) {
      if (!token) return;
      const rec = await refresh.findByHash(hashToken(token));
      if (!rec) return;
      await refresh.revokeFamily(rec.familyId, now());
      await log('LOGOUT', ctx, { targetId: rec.userId });
    },

    async logoutEverywhere(userId, ctx = {}) {
      await refresh.revokeAllForUser(userId, now());
      await users.update(userId, { tokenVersion: ((await users.findById(userId))?.tokenVersion ?? 0) + 1 });
      await log('LOGOUT_ALL', { ...ctx, actorId: userId }, { targetId: userId });
    },

    async getUser(id) {
      const u = await users.findById(id);
      if (!u || !u.active) throw unauthorized('Account no longer exists');
      return view(u);
    },

    async updateProfile(userId, patch, ctx = {}) {
      const allowed = {};
      for (const k of ['preferredLanguage', 'theme', 'name', 'phone']) if (patch[k] !== undefined) allowed[k] = patch[k];
      const u = await users.update(userId, allowed);
      if (!u) throw notFound('Account not found');
      if (Object.keys(allowed).some((k) => k !== 'theme')) await log('PROFILE_UPDATED', { ...ctx, actorId: userId }, { targetId: userId, meta: { fields: Object.keys(allowed) } });
      return view(u);
    },

    // ───────────── password lifecycle ─────────────
    async changePassword(userId, { currentPassword, newPassword }, ctx = {}) {
      const user = await users.findById(userId);
      if (!user) throw unauthorized();
      const { ok } = await hasher.verify(user.passwordHash, currentPassword);
      if (!ok) {
        await log('PASSWORD_CHANGE_FAILED', { ...ctx, actorId: userId }, { targetId: userId });
        throw forbidden('Your current password is not correct.');
      }
      if (currentPassword === newPassword) throw badRequest('Choose a password you have not used just now.');
      requireAcceptable(newPassword, user);
      await users.update(userId, { passwordHash: await hasher.hash(newPassword), tokenVersion: (user.tokenVersion ?? 0) + 1 });
      await refresh.revokeAllForUser(userId, now());
      await log('PASSWORD_CHANGED', { ...ctx, actorId: userId }, { targetId: userId });
      return issueSession(await users.findById(userId), ctx);
    },

    /** Always resolves the same way, so it cannot be used to discover which emails have accounts. */
    async forgotPassword(email, ctx = {}) {
      const user = await users.findByEmail(email);
      if (!user || !user.active) return;
      await authTokens.invalidateForUser(user.id, 'reset');
      const token = newOpaqueToken();
      await authTokens.create({ id: newId(), userId: user.id, purpose: 'reset', tokenHash: hashToken(token), expiresAt: now() + A.resetTtlMinutes * MIN });
      await log('PASSWORD_RESET_REQUESTED', ctx, { targetId: user.id });
      // Not awaited: SMTP latency would otherwise reveal which emails have accounts.
      void Promise.resolve(mailer.send({
        to: user.email,
        subject: 'Reset your ZeroSignal password',
        text: `Hello ${user.name.split(' ')[0]},\n\nUse this link to choose a new password (valid for ${A.resetTtlMinutes} minutes):\n${mailLink('/reset-password', token)}\n\nIf you did not ask for this, ignore this message; your password has not changed.`,
      })).catch(() => {});
    },

    async resetPassword({ token, newPassword }, ctx = {}) {
      const rec = await authTokens.findByHash(hashToken(token), 'reset');
      if (!rec || rec.usedAt || rec.expiresAt <= now()) throw badRequest('This reset link is invalid or has expired. Request a new one.');
      const user = await users.findById(rec.userId);
      if (!user || !user.active) throw badRequest('This reset link is invalid or has expired. Request a new one.');
      requireAcceptable(newPassword, user);
      await users.update(user.id, { passwordHash: await hasher.hash(newPassword), failedLogins: 0, lockedUntil: null, tokenVersion: (user.tokenVersion ?? 0) + 1 });
      await authTokens.markUsed(rec.id, now());
      await refresh.revokeAllForUser(user.id, now());
      await log('PASSWORD_RESET', ctx, { targetId: user.id });
    },

    // ───────────── staff accounts (admin-created) ─────────────
    async createAccount(actor, { name, email, role }, ctx = {}) {
      if (!ROLES.includes(role)) throw badRequest('Unknown role');
      if (await users.findByEmail(email)) throw conflict('A user with that email already exists');
      // The account starts with an unusable random password; the person sets their own via the invite link.
      const user = await users.create({
        name, email, role, passwordHash: await hasher.hash(newOpaqueToken(24)), active: true, preferredLanguage: 'en', invitePending: true,
        failedLogins: 0, lockedUntil: null, totp: { enabled: false }, createdAt: now(),
      });
      await log('ACCOUNT_CREATED', { ...ctx, actorId: actor.id }, { targetId: user.id, meta: { role } });
      const inviteUrl = await this.sendInvite(user, actor, ctx);
      return { user: { ...view(user), invitePending: true }, inviteUrl };
    },

    async sendInvite(userOrId, actor, ctx = {}) {
      const user = typeof userOrId === 'string' ? await users.findById(userOrId) : userOrId;
      if (!user) throw notFound('User not found');
      await authTokens.invalidateForUser(user.id, 'invite');
      const token = newOpaqueToken();
      await authTokens.create({ id: newId(), userId: user.id, purpose: 'invite', tokenHash: hashToken(token), expiresAt: now() + A.inviteTtlHours * 3_600_000 });
      const inviteUrl = mailLink('/setup-account', token);
      await log('INVITE_SENT', { ...ctx, actorId: actor?.id }, { targetId: user.id });
      await mailer.send({
        to: user.email,
        subject: 'Your ZeroSignal account is ready',
        text: `Hello ${user.name.split(' ')[0]},\n\nAn administrator created a ${user.role} account for you. Set your password here (valid for ${A.inviteTtlHours} hours):\n${inviteUrl}\n`,
      }).catch(() => {});
      return inviteUrl;
    },

    async completeInvite({ token, newPassword }, ctx = {}) {
      const rec = await authTokens.findByHash(hashToken(token), 'invite');
      if (!rec || rec.usedAt || rec.expiresAt <= now()) throw badRequest('This invite link is invalid or has expired. Ask an administrator to send a new one.');
      const user = await users.findById(rec.userId);
      if (!user || !user.active) throw badRequest('This invite link is invalid or has expired. Ask an administrator to send a new one.');
      requireAcceptable(newPassword, user);
      const updated = await users.update(user.id, { passwordHash: await hasher.hash(newPassword), invitePending: false, lastLoginAt: now() });
      await authTokens.markUsed(rec.id, now());
      await log('INVITE_ACCEPTED', ctx, { targetId: user.id });
      return issueSession(updated, ctx);
    },

    async setRole(actor, userId, role, ctx = {}) {
      if (!ROLES.includes(role)) throw badRequest('Unknown role');
      if (actor.id === userId) throw conflict('You cannot change your own role');
      const before = await users.findById(userId);
      if (!before) throw notFound('User not found');
      const u = await users.update(userId, { role });
      await refresh.revokeAllForUser(userId, now()); // the new role takes effect at the next refresh
      await log('ROLE_CHANGED', { ...ctx, actorId: actor.id }, { targetId: userId, meta: { from: before.role, to: role } });
      return view(u);
    },

    async setActive(actor, userId, active, ctx = {}) {
      if (actor.id === userId) throw conflict('You cannot deactivate your own account');
      const u = await users.update(userId, { active });
      if (!u) throw notFound('User not found');
      if (!active) await refresh.revokeAllForUser(userId, now());
      await log(active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED', { ...ctx, actorId: actor.id }, { targetId: userId });
      return view(u);
    },

    // ───────────── two-factor (TOTP) for staff ─────────────
    async begin2fa(userId) {
      const user = await users.findById(userId);
      if (!user) throw unauthorized();
      if (!STAFF.has(user.role)) throw forbidden('Two-factor authentication is available to admins and broadcasters.');
      if (user.totp?.enabled) throw conflict('Two-factor authentication is already on.');
      const s = generateSecret();
      await users.update(userId, { totp: { ...(user.totp ?? {}), pendingSealed: seal(s, secret), enabled: false } });
      return { secret: s, otpauthUri: otpauthUri({ secret: s, account: user.email }) };
    },

    async enable2fa(userId, code, ctx = {}) {
      const user = await users.findById(userId);
      if (!user?.totp?.pendingSealed) throw badRequest('Start the setup first.');
      const s = open(user.totp.pendingSealed, secret);
      const step = verifyTotp(s, code, { nowMs: now() });
      if (step == null) throw badRequest('That code is not valid. Check the time on your phone and try again.');
      const backupCodes = Array.from({ length: 8 }, () => `${newOpaqueToken(4).slice(0, 5).toLowerCase()}-${newOpaqueToken(4).slice(0, 5).toLowerCase()}`);
      await users.update(userId, { totp: { enabled: true, secretSealed: seal(s, secret), lastStep: step, backupHashes: backupCodes.map((c) => hashToken(c)) } });
      await log('TWO_FACTOR_ENABLED', { ...ctx, actorId: userId }, { targetId: userId });
      return { backupCodes };
    },

    async disable2fa(userId, { password, code }, ctx = {}) {
      const user = await users.findById(userId);
      if (!user?.totp?.enabled) throw badRequest('Two-factor authentication is not on.');
      if (!(await hasher.verify(user.passwordHash, password)).ok) throw forbidden('Your password is not correct.');
      const ok = verifyTotp(open(user.totp.secretSealed, secret), code, { nowMs: now(), lastUsedStep: user.totp.lastStep ?? null }) != null || (user.totp.backupHashes ?? []).includes(hashToken(String(code).replace(/\s/g, '').toLowerCase()));
      if (!ok) throw forbidden('That authentication code is not valid.');
      await users.update(userId, { totp: { enabled: false } });
      await log('TWO_FACTOR_DISABLED', { ...ctx, actorId: userId }, { targetId: userId });
    },
  };
}
