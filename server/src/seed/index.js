/**
 * Database seeding (CLI only — there is no HTTP route, socket event or UI path that reaches this module).
 *
 * `runSeed` is idempotent: it removes documents previously inserted by a seed run (those carrying the
 * internal `seedBatchId`) and re-inserts a deterministic dataset with stable ids, so running it twice
 * yields the same collections and never duplicates. Anything created by real use is never touched,
 * and `clean` removes exactly the seeded documents.
 */
import { ALL_MODELS } from '../models/index.js';
import { getSigner } from '../services/signing.js';
import { createHasher } from '../services/auth/passwords.js';
import { buildSeedDataset, SEED_BATCH_ID } from './dataset.js';

const { User, Broadcast, EmergencyMessage, NetworkMetric, QualityEvent, ReceiverSession, DeliveryLog, AiUsage, Acknowledgment } = ALL_MODELS;

const SEED_ORDER = [
  ['broadcasts', Broadcast],
  ['messages', EmergencyMessage],
  ['metrics', NetworkMetric],
  ['events', QualityEvent],
  ['sessions', ReceiverSession],
  ['deliveries', DeliveryLog],
  ['acks', Acknowledgment],
  ['aiUsage', AiUsage],
];

const marked = { seedBatchId: { $exists: true } };

/** Remove seeded documents. Users are removed only when `includeUsers` (full clean). */
export async function cleanSeed({ includeUsers = true } = {}) {
  const removed = {};
  for (const [name, Model] of SEED_ORDER) removed[name] = (await Model.deleteMany(marked)).deletedCount;
  if (includeUsers) removed.users = (await User.deleteMany(marked)).deletedCount;
  return removed;
}

export async function seedStatus() {
  const counts = {};
  for (const [name, Model] of [['users', User], ...SEED_ORDER]) counts[name] = await Model.countDocuments(marked);
  return { counts, totals: { users: await User.countDocuments(), broadcasts: await Broadcast.countDocuments(), messages: await EmergencyMessage.countDocuments() } };
}

/**
 * @param {{ now?: number, emailDomain: string, password: string, hashRounds?: object }} opts
 */
export async function runSeed({ now = Date.now(), emailDomain, password, argon2 } = {}) {
  if (!emailDomain || !password) throw new Error('runSeed needs emailDomain and password');
  const hasher = createHasher(argon2);
  const data = buildSeedDataset({ now, passwordHash: await hasher.hash(password), emailDomain, signer: getSigner() });

  // Never hijack a real account: if one of the seeded addresses already belongs to a non-seeded user, stop.
  const clash = await User.find({ email: { $in: data.users.map((u) => u.email) }, seedBatchId: { $exists: false } }, { email: 1 }).lean();
  if (clash.length) throw new Error(`These addresses already belong to real accounts: ${clash.map((c) => c.email).join(', ')}. Choose a different SEED_EMAIL_DOMAIN.`);

  await cleanSeed({ includeUsers: false });

  // Users are upserted by email so re-seeding never duplicates them (and gets the current password).
  await User.bulkWrite(
    data.users.map(({ _id, ...rest }) => ({
      updateOne: { filter: { email: rest.email }, update: { $set: rest, $setOnInsert: { _id } }, upsert: true },
    })),
  );

  const inserted = { users: data.users.length };
  for (const [name, Model] of SEED_ORDER) {
    await Model.insertMany(data[name], { ordered: false });
    inserted[name] = data[name].length;
  }
  return { inserted, users: data.users.map((u) => ({ name: u.name, email: u.email, role: u.role })) };
}

export { SEED_BATCH_ID };
