import { Request, Response, NextFunction } from 'express';
import { tenantStorage } from '../config/tenantStore';
import { Errors } from '../utils/errors';

/**
 * B2.3 — establishes the per-request tenant context (AsyncLocalStorage) that the Prisma
 * tenant-guard extension reads to auto-scope every query by tenant_id. Must run after
 * authGuard. We wrap the remainder of the request chain inside tenantStorage.run() so all
 * downstream async DB calls inherit the context.
 *
 * NOTE: Postgres RLS is documented in PLAN as the primary isolation layer, but the local
 * dev connection uses the `postgres` superuser which bypasses RLS. The Prisma tenant-guard
 * is therefore the *enforced* isolation mechanism here (defense-in-depth #2). See
 * BACKEND_STATUS.md "Deviations".
 */
export function tenantContext(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) {
    return next(Errors.unauthenticated());
  }
  tenantStorage.run({ tenantId: req.auth.tenantId, userId: req.auth.userId }, () => {
    next();
  });
}
