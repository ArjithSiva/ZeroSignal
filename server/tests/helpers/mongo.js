/**
 * Test MongoDB provider. Order of preference:
 *   1. MONGODB_URI_TEST  — any MongoDB you already have (a throwaway database name is used);
 *   2. mongodb-memory-server — downloads a mongod binary on first run (needs internet).
 * If neither works, `available` is false and DB suites SKIP (loudly) instead of failing.
 */
import mongoose from 'mongoose';

export async function startTestMongo() {
  try {
    if (process.env.MONGODB_URI_TEST) {
      const uri = process.env.MONGODB_URI_TEST.replace(/\/([^/?]*)(\?|$)/, `/zerosignal_test_${Date.now()}$2`);
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      return { available: true, reason: 'MONGODB_URI_TEST', stop: async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } };
    }
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri('zerosignal_test'), { serverSelectionTimeoutMS: 8000 });
    return { available: true, reason: 'mongodb-memory-server', stop: async () => { await mongoose.disconnect(); await server.stop(); } };
  } catch (err) {
    console.warn(`\n⚠ DB-backed tests SKIPPED — no MongoDB available (${String(err.message).split('\n')[0]}).\n  Set MONGODB_URI_TEST or allow mongodb-memory-server to download a mongod binary.\n`);
    return { available: false, reason: String(err.message), stop: async () => {} };
  }
}
