import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../config/env';
import { Errors } from './errors';

export type JwtRole = 'owner' | 'manager' | 'admin' | 'finance';

export interface AccessClaims {
  userId: string;
  tenantId: string;
  role: JwtRole;
}

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshKey = new TextEncoder().encode(env.JWT_REFRESH_SECRET);
const ALG = 'HS256';

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_TTL)
    .sign(accessKey);
}

export interface RefreshClaims {
  userId: string;
  tenantId: string;
  /** unique token id (jti) — its sha256 is stored in refresh_tokens for rotation/revocation */
  jti: string;
}

export async function signRefreshToken(claims: RefreshClaims): Promise<string> {
  return new SignJWT({ userId: claims.userId, tenantId: claims.tenantId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setJti(claims.jti)
    .setExpirationTime(env.JWT_REFRESH_TTL)
    .sign(refreshKey);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey, { algorithms: [ALG] });
    return {
      userId: String(payload.userId),
      tenantId: String(payload.tenantId),
      role: payload.role as JwtRole,
    };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw Errors.tokenExpired();
    throw Errors.unauthenticated('Invalid access token');
  }
}

export async function verifyRefreshToken(
  token: string,
): Promise<{ userId: string; tenantId: string; jti: string }> {
  try {
    const { payload } = await jwtVerify(token, refreshKey, { algorithms: [ALG] });
    return {
      userId: String(payload.userId),
      tenantId: String(payload.tenantId),
      jti: String(payload.jti),
    };
  } catch {
    throw Errors.unauthenticated('Invalid or expired refresh token');
  }
}
