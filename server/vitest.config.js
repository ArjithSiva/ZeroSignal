import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run may download a MongoDB binary for mongodb-memory-server
    // DB-backed suites share one in-memory MongoDB per file; keep files serial to be safe.
    fileParallelism: false,
  },
});
