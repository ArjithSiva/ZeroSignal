import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAlert, makeSigner } from './helpers.js';

const signer = makeSigner();
vi.mock('../src/lib/api.js', () => ({
  API_URL: '',
  api: {
    get: vi.fn(async () => ({ data: { publicKey: signer.publicKey } })),
    post: vi.fn(async () => {
      throw new Error('offline');
    }),
  },
}));

const cache = await import('../src/lib/alertCache.js');

beforeEach(async () => {
  cache.resetKeyCache();
  await cache.clearCachedAlert('b'.repeat(24));
});

describe('alert cache', () => {
  it('verifies a genuine signature and rejects a forged one', async () => {
    const a = makeAlert(signer);
    expect(await cache.verifySigned(a.signed.en)).toBe('verified');
    const forged = { ...a.signed.en, payload: { ...a.signed.en.payload, h: 'All clear' } };
    expect(await cache.verifySigned(forged)).toBe('rejected');
  });

  it('caches only CRITICAL alerts that verify', async () => {
    const id = 'b'.repeat(24);
    expect((await cache.saveCriticalAlert(id, makeAlert(signer, { priority: 'HIGH' }))).saved).toBe(false);
    const forged = makeAlert(signer);
    forged.signed.en.payload.h = 'tampered';
    expect((await cache.saveCriticalAlert(id, forged)).saved).toBe(false);
    expect((await cache.saveCriticalAlert(id, makeAlert(signer))).saved).toBe(true);
  });

  it('re-verifies on read and flags a tampered cache entry', async () => {
    const id = 'b'.repeat(24);
    await cache.saveCriticalAlert(id, makeAlert(signer));
    const ok = await cache.readLastVerified(id);
    expect(ok.verified).toBe(true);
    expect(ok.tampered).toBe(false);

    await cache.tamperCachedAlert(id);
    const bad = await cache.readLastVerified(id);
    expect(bad.tampered).toBe(true);
    expect(bad.verified).toBe(false);
  });

  it('does not overwrite a newer cached alert with an older one', async () => {
    const id = 'b'.repeat(24);
    await cache.saveCriticalAlert(id, makeAlert(signer, { sentAt: 2000 }));
    const res = await cache.saveCriticalAlert(id, makeAlert(signer, { sentAt: 1000 }));
    expect(res.saved).toBe(false);
  });

  it('reports expiry on read', async () => {
    const id = 'b'.repeat(24);
    await cache.saveCriticalAlert(id, makeAlert(signer, { expiresAt: 5000 }), { now: 1000 });
    expect((await cache.readLastVerified(id, { now: 6000 })).expired).toBe(true);
    expect((await cache.readLastVerified(id, { now: 2000 })).expired).toBe(false);
  });
});
