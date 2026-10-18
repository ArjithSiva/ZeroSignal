/**
 * CLI: create the first admin (or any staff account) without the browser.
 *   npm run admin:create -- --email=you@example.org --name="Your Name" [--role=admin|broadcaster]
 * Prints a one-time setup link; the person chooses their own password there. Nothing is stored in a file.
 */
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { createAccountService } from '../services/auth/accounts.js';
import { createMongoAccountRepos } from '../services/auth/accountRepos.js';
import { createHasher } from '../services/auth/passwords.js';
import { createMailer } from '../services/auth/mailer.js';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const email = arg('email')?.trim().toLowerCase();
const name = arg('name')?.trim();
const role = arg('role') ?? 'admin';

if (!email || !name || !['admin', 'broadcaster'].includes(role)) {
  console.error('Usage: npm run admin:create -- --email=you@example.org --name="Your Name" [--role=admin|broadcaster]');
  process.exit(1);
}

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
try {
  const accounts = createAccountService({ repos: createMongoAccountRepos(), config, mailer: createMailer(config.mail), hasher: createHasher(config.auth.argon2) });
  const { user, inviteUrl } = await accounts.createAccount({ id: 'cli', role: 'admin' }, { name, email, role }, { ip: 'cli' });
  console.log(`✔ Created ${role} ${user.email}`);
  console.log(`\nOne-time setup link (valid ${config.auth.inviteTtlHours} h). Shown once, not stored:\n  ${inviteUrl}\n`);
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
