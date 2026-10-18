import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { ensureBootstrapAdmin, seedOnBoot } from '../src/bootstrap.js';
import { createMailer } from '../src/services/auth/mailer.js';
import { createMemoryRepos } from './helpers/memoryRepos.js';

const config = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), CLIENT_ORIGINS: 'https://app.example.org', MAIL_TRANSPORT: 'memory', ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '1' });
const quiet = { log: () => {}, error: () => {} };
const setup = () => {
  const { repos, state } = createMemoryRepos();
  return { repos, state, mailer: createMailer(config.mail) };
};

describe('ensureBootstrapAdmin (hosting without a shell)', () => {
  it('does nothing unless BOOTSTRAP_ADMIN_EMAIL is set', async () => {
    const { repos, mailer, state } = setup();
    expect((await ensureBootstrapAdmin({ config, env: {}, repos, mailer, log: quiet })).action).toBe('disabled');
    expect(state.users.size).toBe(0);
  });

  it('creates the admin once and returns a one-time setup link on the app origin', async () => {
    const { repos, mailer, state } = setup();
    const env = { BOOTSTRAP_ADMIN_EMAIL: 'Owner@Example.org', BOOTSTRAP_ADMIN_NAME: 'Site Owner' };
    const r = await ensureBootstrapAdmin({ config, env, repos, mailer, log: quiet });
    expect(r.action).toBe('created');
    expect(r.inviteUrl).toMatch(/^https:\/\/app\.example\.org\/setup-account\?token=/);
    const [u] = [...state.users.values()];
    expect(u).toMatchObject({ email: 'owner@example.org', role: 'admin', name: 'Site Owner', invitePending: true });
  });

  it('re-issues a fresh link while the password is still unset, and stops once it is set', async () => {
    const { repos, mailer, state } = setup();
    const env = { BOOTSTRAP_ADMIN_EMAIL: 'owner@example.org' };
    const first = await ensureBootstrapAdmin({ config, env, repos, mailer, log: quiet });
    const again = await ensureBootstrapAdmin({ config, env, repos, mailer, log: quiet });
    expect(again.action).toBe('reinvited');
    expect(again.inviteUrl).not.toBe(first.inviteUrl);
    [...state.users.values()][0].invitePending = false;
    const done = await ensureBootstrapAdmin({ config, env, repos, mailer, log: quiet });
    expect(done).toEqual({ action: 'exists', inviteUrl: null });
    expect(state.users.size).toBe(1);
  });

  it('rejects a malformed email without creating anything', async () => {
    const { repos, mailer, state } = setup();
    expect((await ensureBootstrapAdmin({ config, env: { BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' }, repos, mailer, log: quiet })).action).toBe('invalid');
    expect(state.users.size).toBe(0);
  });
});

describe('seedOnBoot', () => {
  it('is off by default and refuses an invalid domain', async () => {
    expect((await seedOnBoot({ env: {}, config, log: quiet })).action).toBe('disabled');
    expect((await seedOnBoot({ env: { SEED_ON_BOOT: 'true', SEED_EMAIL_DOMAIN: 'nope' }, config, log: quiet })).action).toBe('invalid');
  });
});
