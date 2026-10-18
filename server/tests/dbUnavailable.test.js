import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../src/middleware/errors.js';

function run(err) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  errorHandler(err, { app: { locals: { config: { isTest: true, isProd: true } } } }, res, () => {});
  return res;
}

describe('errorHandler when MongoDB is unreachable', () => {
  it('maps mongoose buffering timeouts to 503 DB_UNAVAILABLE', () => {
    const err = Object.assign(new Error('Operation `users.findOne()` buffering timed out after 4000ms'), { name: 'MongooseError' });
    const res = run(err);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0].error.code).toBe('DB_UNAVAILABLE');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/users\.findOne/);
  });
  it('still returns a generic 500 for unknown errors', () => {
    const res = run(new Error('boom'));
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
