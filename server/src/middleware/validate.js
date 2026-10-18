import { z } from 'zod';
import mongoose from 'mongoose';
import { badRequest } from '../utils/errors.js';

/** A 24-char hex string that is a valid ObjectId. */
export const objectId = z.string().refine((v) => mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(v), 'Invalid id');

/**
 * Validate and *replace* req.body / req.query / req.params with zod-parsed values.
 * Unknown keys are stripped (zod default for objects), so extra fields never reach handlers.
 * @param {{ body?: z.ZodTypeAny, query?: z.ZodTypeAny, params?: z.ZodTypeAny }} schemas
 */
export const validate = (schemas) => (req, _res, next) => {
  try {
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const r = schemas[part].safeParse(req[part] ?? {});
      if (!r.success) {
        const details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        throw badRequest('Validation failed', details);
      }
      req[part] = r.data;
    }
    next();
  } catch (e) {
    next(e);
  }
};

export const idParam = z.object({ id: objectId });
