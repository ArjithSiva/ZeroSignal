import { beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { loadConfig } from '../src/config/env.js';
import { createAccountService } from '../src/services/auth/accounts.js';
import { createHasher, checkPasswordPolicy, generatePassword } from '../src/services/auth/passwords.js';
import { createMailer } from '../src/services/auth/mailer.js';
import { hotp, verifyTotp, base32Decode, base32Encode } from '../src/services/auth/totp.js';
import { open, seal } from '../src/services/auth/secretbox.js';
import { verifyToken } from '../src/middleware/auth.js';
import { createMemoryRepos } from './helpers/memoryRepos.js';

const config = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), CLIENT_ORIGINS: 'https://app.example.org', MAIL_TRANSPORT: 'memory', ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '1' });
const hasher = createHasher(config.auth.argon2);
const PW = 'Tr1cky-Harbour-Lamp';
const ctx = { ip: '203.0.113.9', userAgent: 'vitest' };

let clock;
let env;
const mk = () => {
  const { state, repos } = createMemoryRepos();
  const mailer = createMailer(config.mail);
  const svc = createAccountService({ repos, config, mailer, hasher, now: () => clock });
  return { state, repos, mailer, svc };
};
const reg = (over = {}) => env.svc.register({ name: 'Priya Natarajan', email: 'priya@mail.example.org', password: PW, ...over }, ctx);
const tokenFrom = (mail) => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');

beforeEach(() => {
  clock = 1_800_000_000_000;
  env = mk();
});

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC test vector (T=59 → 94287082 with 8 digits)', () => {
    expect(hotp(secret, 1, 8)).toBe('94287082');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('accepts ±1 step, rejects far-off codes and replays', () => {
    const now = 59_000;
    const code = hotp(secret, 1);
    expect(verifyTotp(secret, code, { nowMs: now })).toBe(1);
    expect(verifyTotp(secret, code, { nowMs: now + 30_000 })).toBe(1);
    expect(verifyTotp(secret, code, { nowMs: now + 120_000 })).toBeNull();
    expect(verifyTotp(secret, code, { nowMs: now, lastUsedStep: 1 })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { nowMs: now })).toBeNull();
  });
});

describe('secretbox', () => {
  it('round-trips and rejects tampering or the wrong key', () => {
    const s = seal('JBSWY3DPEHPK3PXP', 'k'.repeat(32));
    expect(open(s, 'k'.repeat(32))).toBe('JBSWY3DPEHPK3PXP');
    expect(() => open(s, 'z'.repeat(32))).toThrow();
    expect(() => open(`${s.slice(0, -2)}xx`, 'k'.repeat(32))).toThrow();
  });
});

describe('password policy and hashing', () => {
  it('rejects short, common, repeated and name-containing passwords', () => {
    expect(checkPasswordPolicy('short1A!').length).toBeGreaterThan(0);
    expect(checkPasswordPolicy('Password123').join()).toMatch(/common/);
    expect(checkPasswordPolicy('aaaaaaaaaaaa').length).toBeGreaterThan(0);
    expect(checkPasswordPolicy('priya-Rocks-2024!', { email: 'priya@x.org' }).join()).toMatch(/email name/);
    expect(checkPasswordPolicy(PW)).toEqual([]);
    expect(checkPasswordPolicy('correct horse battery staple')).toEqual([]);
  });
  it('generatePassword always satisfies the policy', () => {
    for (let i = 0; i < 20; i++) expect(checkPasswordPolicy(generatePassword())).toEqual([]);
  });
  it('hashes with argon2id and verifies; legacy bcrypt verifies and asks for a rehash', async () => {
    const h = await hasher.hash(PW);
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(h, PW)).toEqual({ ok: true, needsRehash: false });
    expect((await hasher.verify(h, 'nope')).ok).toBe(false);
    const legacy = await bcrypt.hash(PW, 4);
    expect(await hasher.verify(legacy, PW)).toEqual({ ok: true, needsRehash: true });
    expect((await hasher.verify('garbage', PW)).ok).toBe(false);
  });
});

describe('registration', () => {
  it('creates a receiver session; role can never be chosen by the caller', async () => {
    const s = await env.svc.register({ name: 'Priya N', email: 'priya@mail.example.org', password: PW, role: 'admin', language: 'ta', phone: '+91 98765 43210' }, ctx);
    expect(s.user.role).toBe('receiver');
    expect(s.user.preferredLanguage).toBe('ta');
    expect(verifyToken(s.accessToken, config).role).toBe('receiver');
    expect(s.refreshToken.length).toBeGreaterThan(30);
  });
  it('enforces the password policy and rejects duplicates', async () => {
    await expect(reg({ password: 'password123' })).rejects.toMatchObject({ status: 400 });
    await reg();
    await expect(reg()).rejects.toMatchObject({ status: 409 });
  });
  it('never stores the raw password or raw refresh token', async () => {
    const s = await reg();
    const dump = JSON.stringify([...env.state.users.values(), ...env.state.refresh.values()]);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain(s.refreshToken);
  });
});

describe('sign-in and lockout', () => {
  beforeEach(async () => void (await reg()));
  const login = (password = PW, extra = {}) => env.svc.login({ email: 'priya@mail.example.org', password, ...extra }, ctx);

  it('signs in with the right password; wrong password and unknown email give the same error', async () => {
    expect((await login()).user.email).toBe('priya@mail.example.org');
    const a = await login('wrong-password').catch((e) => e);
    const b = await env.svc.login({ email: 'ghost@mail.example.org', password: 'whatever-1' }, ctx).catch((e) => e);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.message).toBe(b.message);
  });

  it('locks after 5 failures with escalating backoff, reports retryAfterSec, and resets on success', async () => {
    for (let i = 0; i < 5; i++) await login('bad-password-1').catch(() => {});
    const locked = await login().catch((e) => e); // correct password, but locked
    expect(locked.status).toBe(429);
    expect(locked.code).toBe('ACCOUNT_LOCKED');
    expect(locked.details.retryAfterSec).toBeGreaterThan(0);
    expect(locked.details.retryAfterSec).toBeLessThanOrEqual(60);

    clock += 61_000; // 1-minute lock expires
    await login('bad-password-1').catch(() => {}); // 6th failure → 2 minutes
    const again = await login().catch((e) => e);
    expect(again.details.retryAfterSec).toBeGreaterThan(60);

    clock += 121_000;
    expect((await login()).user.email).toBeTruthy();
    const u = await env.repos.users.findByEmail('priya@mail.example.org');
    expect(u.failedLogins).toBe(0);
    expect(u.lockedUntil).toBeNull();
  });

  it('refuses deactivated accounts', async () => {
    const u = await env.repos.users.findByEmail('priya@mail.example.org');
    await env.repos.users.update(u.id, { active: false });
    await expect(login()).rejects.toMatchObject({ status: 401 });
  });

  it('upgrades a legacy bcrypt hash to argon2id on successful sign-in', async () => {
    const u = await env.repos.users.findByEmail('priya@mail.example.org');
    await env.repos.users.update(u.id, { passwordHash: await bcrypt.hash(PW, 4) });
    await login();
    expect((await env.repos.users.findById(u.id)).passwordHash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('refresh-token rotation', () => {
  it('rotates on every refresh and keeps the family', async () => {
    const s1 = await reg();
    clock += 60_000;
    const s2 = await env.svc.refresh(s1.refreshToken, ctx);
    expect(s2.refreshToken).not.toBe(s1.refreshToken);
    expect(s2.user.email).toBe(s1.user.email);
    clock += 60_000;
    const s3 = await env.svc.refresh(s2.refreshToken, ctx);
    expect(s3.refreshToken).not.toBe(s2.refreshToken);
  });

  it('tolerates two tabs refreshing the same token within the grace window', async () => {
    const s1 = await reg();
    clock += 60_000;
    const a = await env.svc.refresh(s1.refreshToken, ctx);
    clock += 2_000;
    const b = await env.svc.refresh(s1.refreshToken, ctx); // same retired token, 2 s later
    expect(b.refreshToken).not.toBe(a.refreshToken);
    await expect(env.svc.refresh(a.refreshToken, ctx)).resolves.toBeTruthy();
  });

  it('detects reuse of a retired token after the grace window and revokes the whole family', async () => {
    const s1 = await reg();
    clock += 60_000;
    const s2 = await env.svc.refresh(s1.refreshToken, ctx);
    clock += 60_000;
    await expect(env.svc.refresh(s1.refreshToken, ctx)).rejects.toMatchObject({ status: 401 });
    await expect(env.svc.refresh(s2.refreshToken, ctx)).rejects.toMatchObject({ status: 401 }); // thief's and victim's both dead
    expect(env.state.audit.map((e) => e.type)).toContain('TOKEN_REUSE_DETECTED');
  });

  it('rejects expired, unknown and missing tokens', async () => {
    const s1 = await reg();
    await expect(env.svc.refresh('nope-nope-nope-nope-nope-nope', ctx)).rejects.toMatchObject({ status: 401 });
    await expect(env.svc.refresh(undefined, ctx)).rejects.toMatchObject({ status: 401 });
    clock += (config.auth.refreshTtlDays + 1) * 86_400_000;
    await expect(env.svc.refresh(s1.refreshToken, ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('logout kills the session; logout-everywhere kills every device', async () => {
    const a = await reg();
    const b = await env.svc.login({ email: 'priya@mail.example.org', password: PW }, ctx);
    await env.svc.logout(a.refreshToken, ctx);
    await expect(env.svc.refresh(a.refreshToken, ctx)).rejects.toBeTruthy();
    await expect(env.svc.refresh(b.refreshToken, ctx)).resolves.toBeTruthy();
    const c = await env.svc.login({ email: 'priya@mail.example.org', password: PW }, ctx);
    await env.svc.logoutEverywhere(c.user.id, ctx);
    await expect(env.svc.refresh(c.refreshToken, ctx)).rejects.toBeTruthy();
  });

  it('a deactivated user cannot refresh', async () => {
    const s = await reg();
    const admin = { id: 'admin-1' };
    await env.svc.setActive(admin, s.user.id, false, ctx);
    await expect(env.svc.refresh(s.refreshToken, ctx)).rejects.toMatchObject({ status: 401 });
  });
});

describe('password change, forgot and reset', () => {
  it('change needs the current password, enforces policy, and ends other sessions', async () => {
    const s = await reg();
    await expect(env.svc.changePassword(s.user.id, { currentPassword: 'wrong-wrong-1', newPassword: 'Another-Strong-Pass9' }, ctx)).rejects.toMatchObject({ status: 403 });
    await expect(env.svc.changePassword(s.user.id, { currentPassword: PW, newPassword: 'short' }, ctx)).rejects.toMatchObject({ status: 400 });
    const s2 = await env.svc.changePassword(s.user.id, { currentPassword: PW, newPassword: 'Another-Strong-Pass9' }, ctx);
    await expect(env.svc.refresh(s.refreshToken, ctx)).rejects.toBeTruthy();
    await expect(env.svc.refresh(s2.refreshToken, ctx)).resolves.toBeTruthy();
    await expect(env.svc.login({ email: 'priya@mail.example.org', password: PW }, ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('forgot-password is silent for unknown emails and mails a single-use, expiring link for real ones', async () => {
    await reg();
    await env.svc.forgotPassword('ghost@mail.example.org', ctx);
    expect(env.mailer.outbox).toHaveLength(0);
    await env.svc.forgotPassword('priya@mail.example.org', ctx);
    expect(env.mailer.outbox).toHaveLength(1);
    const token = tokenFrom(env.mailer.outbox[0]);
    expect(env.mailer.outbox[0].text).toContain('/reset-password?token=');
    expect(JSON.stringify([...env.state.authTokens.values()])).not.toContain(token); // stored hashed

    await expect(env.svc.resetPassword({ token, newPassword: 'password123' }, ctx)).rejects.toMatchObject({ status: 400 });
    await env.svc.resetPassword({ token, newPassword: 'Fresh-Reset-Pass7' }, ctx);
    await expect(env.svc.resetPassword({ token, newPassword: 'Fresh-Reset-Pass8' }, ctx)).rejects.toMatchObject({ status: 400 }); // single use
    expect((await env.svc.login({ email: 'priya@mail.example.org', password: 'Fresh-Reset-Pass7' }, ctx)).user.email).toBeTruthy();
  });

  it('reset links expire, a newer request replaces the older one, and reset clears a lockout and old sessions', async () => {
    const s = await reg();
    await env.svc.forgotPassword('priya@mail.example.org', ctx);
    const t1 = tokenFrom(env.mailer.outbox[0]);
    await env.svc.forgotPassword('priya@mail.example.org', ctx);
    const t2 = tokenFrom(env.mailer.outbox[1]);
    await expect(env.svc.resetPassword({ token: t1, newPassword: 'Fresh-Reset-Pass7' }, ctx)).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < 5; i++) await env.svc.login({ email: 'priya@mail.example.org', password: 'bad-password-1' }, ctx).catch(() => {});
    clock += (config.auth.resetTtlMinutes + 1) * 60_000;
    await expect(env.svc.resetPassword({ token: t2, newPassword: 'Fresh-Reset-Pass7' }, ctx)).rejects.toMatchObject({ status: 400 });
    await env.svc.forgotPassword('priya@mail.example.org', ctx);
    await env.svc.resetPassword({ token: tokenFrom(env.mailer.outbox[2]), newPassword: 'Fresh-Reset-Pass7' }, ctx);
    await expect(env.svc.refresh(s.refreshToken, ctx)).rejects.toBeTruthy();
    expect((await env.svc.login({ email: 'priya@mail.example.org', password: 'Fresh-Reset-Pass7' }, ctx)).user.email).toBeTruthy();
  });
});

describe('admin-created accounts (invite link)', () => {
  const admin = { id: 'admin-1', role: 'admin' };

  it('creates a staff account that cannot sign in until the invite is accepted', async () => {
    const { user, inviteUrl } = await env.svc.createAccount(admin, { name: 'Karthik Rao', email: 'karthik@mail.example.org', role: 'broadcaster' }, ctx);
    expect(user.role).toBe('broadcaster');
    expect(inviteUrl).toContain('/setup-account?token=');
    expect(env.mailer.outbox[0].to).toBe('karthik@mail.example.org');
    await expect(env.svc.login({ email: 'karthik@mail.example.org', password: 'Anything-Guess-1' }, ctx)).rejects.toMatchObject({ status: 401 });

    const token = new URL(inviteUrl).searchParams.get('token');
    const s = await env.svc.completeInvite({ token, newPassword: 'Granite-Strong-Pass3' }, ctx);
    expect(s.user.role).toBe('broadcaster');
    await expect(env.svc.completeInvite({ token, newPassword: 'Granite-Strong-Pass4' }, ctx)).rejects.toMatchObject({ status: 400 });
    expect((await env.svc.login({ email: 'karthik@mail.example.org', password: 'Granite-Strong-Pass3' }, ctx)).user.role).toBe('broadcaster');
  });

  it('rejects duplicate emails and weak invite passwords; invites expire', async () => {
    await env.svc.createAccount(admin, { name: 'Karthik Rao', email: 'karthik@mail.example.org', role: 'broadcaster' }, ctx);
    await expect(env.svc.createAccount(admin, { name: 'Karthik Rao', email: 'karthik@mail.example.org', role: 'admin' }, ctx)).rejects.toMatchObject({ status: 409 });
    const token = tokenFrom(env.mailer.outbox[0]);
    await expect(env.svc.completeInvite({ token, newPassword: 'weak' }, ctx)).rejects.toMatchObject({ status: 400 });
    clock += (config.auth.inviteTtlHours + 1) * 3_600_000;
    await expect(env.svc.completeInvite({ token, newPassword: 'Granite-Strong-Pass3' }, ctx)).rejects.toMatchObject({ status: 400 });
  });

  it('role changes and deactivation are audited; an admin cannot demote or deactivate themselves', async () => {
    const s = await reg();
    await env.svc.setRole(admin, s.user.id, 'broadcaster', ctx);
    expect((await env.repos.users.findById(s.user.id)).role).toBe('broadcaster');
    await expect(env.svc.setRole({ id: s.user.id }, s.user.id, 'admin', ctx)).rejects.toMatchObject({ status: 409 });
    await expect(env.svc.setActive({ id: s.user.id }, s.user.id, false, ctx)).rejects.toMatchObject({ status: 409 });
    const types = env.state.audit.map((e) => e.type);
    expect(types).toContain('ROLE_CHANGED');
    // a role change ends existing sessions so the new role applies at the next sign-in
    await expect(env.svc.refresh(s.refreshToken, ctx)).rejects.toBeTruthy();
  });
});

describe('two-factor authentication (staff)', () => {
  const admin = { id: 'admin-1' };
  const staff = async () => {
    const { inviteUrl } = await env.svc.createAccount(admin, { name: 'Asha Raman', email: 'asha@mail.example.org', role: 'admin' }, ctx);
    return env.svc.completeInvite({ token: new URL(inviteUrl).searchParams.get('token'), newPassword: 'Harbour-Strong-Pass5' }, ctx);
  };
  const L = (extra = {}) => env.svc.login({ email: 'asha@mail.example.org', password: 'Harbour-Strong-Pass5', ...extra }, ctx);

  it('is not offered to receivers', async () => {
    const s = await reg();
    await expect(env.svc.begin2fa(s.user.id)).rejects.toMatchObject({ status: 403 });
  });

  it('enrol → login needs a code → replay rejected → backup code works once → disable', async () => {
    const s = await staff();
    const { secret, otpauthUri } = await env.svc.begin2fa(s.user.id);
    expect(otpauthUri).toContain('otpauth://totp/');
    await expect(env.svc.enable2fa(s.user.id, '000000', ctx)).rejects.toMatchObject({ status: 400 });
    const step = Math.floor(clock / 1000 / 30);
    const { backupCodes } = await env.svc.enable2fa(s.user.id, hotp(secret, step), ctx);
    expect(backupCodes).toHaveLength(8);
    expect(JSON.stringify([...env.state.users.values()])).not.toContain(secret); // sealed at rest

    await expect(L()).rejects.toMatchObject({ code: 'TOTP_REQUIRED' });
    await expect(L({ totp: '123456' })).rejects.toMatchObject({ status: 401 });
    clock += 30_000;
    const code = hotp(secret, Math.floor(clock / 1000 / 30));
    expect((await L({ totp: code })).user.twoFactorEnabled).toBe(true);
    await expect(L({ totp: code })).rejects.toMatchObject({ status: 401 }); // same code reused

    expect((await L({ totp: backupCodes[0] })).user.email).toBeTruthy();
    await expect(L({ totp: backupCodes[0] })).rejects.toMatchObject({ status: 401 }); // single use

    clock += 30_000;
    await env.svc.disable2fa(s.user.id, { password: 'Harbour-Strong-Pass5', code: hotp(secret, Math.floor(clock / 1000 / 30)) }, ctx);
    expect((await L()).user.twoFactorEnabled).toBe(false);
  });
});

describe('audit trail', () => {
  it('records auth events without secrets', async () => {
    const s = await reg();
    await env.svc.login({ email: 'priya@mail.example.org', password: 'bad-password-1' }, ctx).catch(() => {});
    await env.svc.login({ email: 'priya@mail.example.org', password: PW }, ctx);
    await env.svc.changePassword(s.user.id, { currentPassword: PW, newPassword: 'Another-Strong-Pass9' }, ctx);
    const types = env.state.audit.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['REGISTER', 'LOGIN_FAILED', 'LOGIN_SUCCESS', 'PASSWORD_CHANGED']));
    const dump = JSON.stringify(env.state.audit);
    for (const secret of [PW, 'Another-Strong-Pass9', 'bad-password-1', s.refreshToken]) expect(dump).not.toContain(secret);
  });
});
