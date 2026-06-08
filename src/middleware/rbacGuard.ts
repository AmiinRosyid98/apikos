import { Request, Response, NextFunction } from 'express';
import { JwtRole } from '../utils/jwt';
import { Errors } from '../utils/errors';
import { prisma } from '../config/database';

/** Role groups from PLAN A10 / §3 notation. */
export const ALL: JwtRole[] = ['owner', 'manager', 'admin', 'finance'];
export const ADMIN_PLUS: JwtRole[] = ['owner', 'manager', 'admin'];
export const MANAGER_PLUS: JwtRole[] = ['owner', 'manager'];
export const FINANCE_PLUS: JwtRole[] = ['owner', 'manager', 'finance'];
export const OWNER_ONLY: JwtRole[] = ['owner'];
export const OWNER_MANAGER: JwtRole[] = ['owner', 'manager'];

/**
 * B2.4 — role gate. Pass the allowed role list (use the groups above).
 * Property-scope enforcement (limiting manager/admin/finance to user_property_access) is
 * handled separately by `loadPropertyScope` + per-service checks, because scoping depends
 * on the resource's property which the controller resolves.
 */
export function rbacGuard(allowedRoles: JwtRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(Errors.unauthenticated());
    if (!allowedRoles.includes(req.auth.role)) {
      return next(Errors.forbidden(`Role '${req.auth.role}' is not permitted for this action`));
    }
    next();
  };
}

/**
 * Loads the caller's property scope into req.propertyScope.
 *   - owner                         → undefined (full access to all tenant properties)
 *   - non-owner with NO access rows → undefined (UNRESTRICTED — see all tenant properties)
 *   - non-owner with access rows    → array of allowed propertyIds (RESTRICTED to those)
 *
 * PRD §13 grants every role "Lihat semua properti"; the property-access list is an
 * OPT-IN restriction the owner applies ("Owner dapat membatasi akses Manager ke properti
 * tertentu saja", PRD §6.11). So an empty list means "not restricted", not "no access".
 * `undefined` therefore consistently means "unrestricted" everywhere downstream.
 */
export async function loadPropertyScope(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.auth) return next(Errors.unauthenticated());
    if (req.auth.role === 'owner') {
      req.propertyScope = undefined; // all
      return next();
    }
    const rows = await prisma.userPropertyAccess.findMany({
      where: { userId: req.auth.userId },
      select: { propertyId: true },
    });
    // Empty restriction list ⇒ unrestricted (see all). Non-empty ⇒ restricted to those.
    req.propertyScope = rows.length ? rows.map((r) => r.propertyId) : undefined;
    next();
  } catch (e) {
    next(e);
  }
}

/** Throws NOT_FOUND if a property-scoped user may not touch the given property. */
export function assertPropertyAccess(req: Request, propertyId: string): void {
  if (!req.auth) throw Errors.unauthenticated();
  if (req.auth.role === 'owner') return;
  const scope = req.propertyScope;
  if (scope === undefined) return; // unrestricted
  if (!scope.includes(propertyId)) {
    // Do not leak existence — treat as NOT_FOUND per §2.2.
    throw Errors.notFound('Resource not found');
  }
}
