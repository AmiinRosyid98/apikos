import bcrypt from 'bcrypt';
import { env } from '../config/env';

/** bcrypt cost >= 12 (PLAN B2 / spec). */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
