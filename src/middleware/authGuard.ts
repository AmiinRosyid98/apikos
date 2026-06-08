import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { Errors } from '../utils/errors';

/**
 * B2.2 — verifies the Bearer access token and populates req.auth.
 * Never trusts tenant_id/role from the body — only from the signed JWT.
 */
export async function authGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return next(Errors.unauthenticated('Missing Bearer token'));
    }
    const claims = await verifyAccessToken(token);
    req.auth = { userId: claims.userId, tenantId: claims.tenantId, role: claims.role };
    next();
  } catch (e) {
    next(e);
  }
}
