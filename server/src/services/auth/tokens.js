import crypto from 'node:crypto';

/** Opaque random token (URL-safe). Only its sha256 is ever stored. */
export const newOpaqueToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const newId = () => crypto.randomBytes(12).toString('hex');
