import crypto from 'crypto';
import { sha256 } from '../../utils/crypto';

/**
 * API-key generation (PRD Modul 22).
 *
 * Full key format: `kos_live_<base62 secret, 40 chars>` (e.g. kos_live_Ab12Cd34…).
 *   - The secret is 40 base62 chars (~238 bits) so collisions/brute-force are infeasible.
 *   - We store ONLY `sha256(fullKey)` (keyHash) — never the plaintext — plus a short visible
 *     `keyPrefix` (the literal `kos_live_` + the first 4 secret chars) for dashboard display.
 *   - The FULL plaintext is returned to the caller exactly ONCE in the create response and can
 *     never be retrieved again (hash-once / show-once).
 */

export const KEY_LIVE_PREFIX = 'kos_live_';
const SECRET_LENGTH = 40; // base62 chars
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function base62(bytes: Buffer, length: number): string {
  let out = '';
  // Use rejection-free mapping: each byte -> index mod 62. Bias is negligible for key purposes,
  // but we draw extra entropy (one byte per char) to keep it simple and uniform-enough.
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i] % 62];
  }
  return out;
}

export interface GeneratedKey {
  /** The full plaintext key — returned to the user ONCE, never stored. */
  fullKey: string;
  /** Short visible prefix stored for display (e.g. "kos_live_Ab12"). */
  keyPrefix: string;
  /** sha256(fullKey) hex — the ONLY representation persisted. */
  keyHash: string;
}

export function generateApiKey(): GeneratedKey {
  const secret = base62(crypto.randomBytes(SECRET_LENGTH), SECRET_LENGTH);
  const fullKey = `${KEY_LIVE_PREFIX}${secret}`;
  const keyPrefix = `${KEY_LIVE_PREFIX}${secret.slice(0, 4)}`;
  const keyHash = sha256(fullKey);
  return { fullKey, keyPrefix, keyHash };
}

/** Compute the stored hash for a presented plaintext key (used at auth time). */
export function hashApiKey(fullKey: string): string {
  return sha256(fullKey);
}

/** Quick shape check before hitting the DB — must look like a kos_live_ key. */
export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_LIVE_PREFIX) && value.length > KEY_LIVE_PREFIX.length + 8;
}
