import crypto from 'crypto';
import { env } from '../config/env';

/**
 * AES-256-GCM application-side encryption for PII (nik, ktp key). PLAN A6 / B1.5.
 * Format stored: base64(iv).base64(authTag).base64(ciphertext)
 * Ciphertext is non-deterministic (random IV) so it never equals plaintext at rest.
 */
const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex'); // 32 bytes
const IV_LENGTH = 12; // GCM standard nonce length
const ALGO = 'aes-256-gcm';

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid ciphertext format');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf8');
}

export function encryptNullable(value?: string | null): string | null {
  if (value === undefined || value === null || value === '') return null;
  return encrypt(value);
}

export function decryptNullable(value?: string | null): string | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

/** SHA-256 hex hash — used for storing refresh/reset/invite tokens (never store raw). */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** URL-safe random token (default 32 bytes → 64 hex chars). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
