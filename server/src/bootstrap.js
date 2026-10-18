/**
 * First-boot setup for hosts without a shell (Render free tier).
 *
 * Everything the CLI tools do is available here through environment variables, so a deployment can be
 * fully configured from the dashboard:
 *
 *   BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_NAME
 *       Creates the first admin if that email has no account yet and prints a ONE-TIME setup link to the
 *       server log (Render → your service → Logs). While the admin has not chosen a password yet, each
 *       restart prints a fresh link. Once the password is set this does nothing.
 *
 *   SEED_ON_BOOT=true  (+ SEED_EMAIL_DOMAIN, optional SEED_USER_PASSWORD)
 *       Loads the pre-built sample history ONCE, only when none exists. It never re-runs, never touches
 *       real data, and `npm run seed:clean` still removes exactly what it created.
 *
 * There is no HTTP route, socket event or UI control that reaches this: it only reads the process
 * environment of the server operator.
 */
import { createAccountService } from './services/auth/accounts.js';
import { createMongoAccountRepos } from './services/auth/accountRepos.js';
import { createHasher, checkPasswordPolicy, generatePassword } from './services/auth/passwords.js';
import { createMailer } from './services/auth/mailer.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?=.{4,100}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

export async function ensureBootstrapAdmin({ config, env = process.env, log = console, repos = createMongoAccountRepos(), mailer = createMailer(config.mail) } = {}) {
  const email = (env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!email) return { action: 'disabled' };
  if (!EMAIL_RE.test(email)) {
    log.error(`[bootstrap] BOOTSTRAP_ADMIN_EMAIL "${email}" is not a valid email address — skipped.`);
    return { action: 'invalid' };
  }
  const name = (env.BOOTSTRAP_ADMIN_NAME ?? '').trim().slice(0, 80) || 'Administrator';
  const accounts = createAccountService({ repos, config, mailer, hasher: createHasher(config.auth.argon2) });
  const actor = { id: 'bootstrap', role: 'admin' };

  const existing = await repos.users.findByEmail(email);
  let inviteUrl = null;
  let action = 'exists';
  if (!existing) {
    ({ inviteUrl } = await accounts.createAccount(actor, { name, email, role: 'admin' }, { ip: 'bootstrap' }));
    action = 'created';
  } else if (existing.invitePending && existing.active) {
    inviteUrl = await accounts.sendInvite(existing, actor, { ip: 'bootstrap' });
    action = 'reinvited';
  }
  if (inviteUrl) {
    log.log(`\n✔ [bootstrap] Admin ${email} ${action === 'created' ? 'created' : 'has not set a password yet'}.\n  One-time setup link (valid ${config.auth.inviteTtlHours} h, shown in this log only):\n  ${inviteUrl}\n`);
  }
  return { action, inviteUrl };
}

export async function seedOnBoot({ env = process.env, log = console, config, models } = {}) {
  if (!truthy(env.SEED_ON_BOOT)) return { action: 'disabled' };
  const emailDomain = (env.SEED_EMAIL_DOMAIN ?? '').trim().toLowerCase();
  if (!DOMAIN_RE.test(emailDomain)) {
    log.error('[bootstrap] SEED_ON_BOOT is on but SEED_EMAIL_DOMAIN is missing or invalid — sample history skipped.');
    return { action: 'invalid' };
  }
  const { runSeed, seedStatus } = await import('./seed/index.js');
  const status = await seedStatus();
  if (status.counts.users > 0) return { action: 'already-seeded' };

  let password = (env.SEED_USER_PASSWORD ?? '').trim();
  const generated = !password;
  if (generated) password = generatePassword();
  else {
    const problems = checkPasswordPolicy(password);
    if (problems.length) {
      log.error(`[bootstrap] SEED_USER_PASSWORD is too weak (${problems.join(' ')}) — sample history skipped.`);
      return { action: 'weak-password' };
    }
  }
  const { inserted, users } = await runSeed({ emailDomain, password, argon2: config.auth.argon2 });
  log.log(`✔ [bootstrap] Sample history loaded (${users.length} accounts at @${emailDomain}).${generated ? `\n  Shared password (shown once): ${password}` : ' Password = SEED_USER_PASSWORD.'}`);
  return { action: 'seeded', inserted };
}

/** Never throws: a failed bootstrap must not stop the API from serving. */
export async function runBootstrap(deps) {
  for (const [label, fn] of [['admin', ensureBootstrapAdmin], ['sample history', seedOnBoot]]) {
    try {
      await fn(deps);
    } catch (e) {
      (deps.log ?? console).error(`[bootstrap] ${label} failed: ${e.message}`);
    }
  }
}
