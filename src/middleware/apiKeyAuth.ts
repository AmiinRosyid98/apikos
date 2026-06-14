import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { tenantStorage, runUnscoped } from '../config/tenantStore';
import { Errors } from '../utils/errors';
import { hashApiKey, looksLikeApiKey } from '../modules/apikeys/apikeys.keygen';
import { assertApiAccessPlan } from '../services/plan.service';

/**
 * PUBLIC API authentication (PRD Modul 22 — Premium-only).
 *
 * Mounted OUTSIDE the JWT-protected router on /api/ext/v1 (like the payment webhook + /public
 * landing). It:
 *   1. reads the key from `Authorization: Bearer kos_live_…` OR the `X-API-Key` header;
 *   2. sha256-hashes it and looks up an ACTIVE, NON-revoked, NON-expired key (lookup runs
 *      UNSCOPED — no tenant is known yet — and matches the unique keyHash, so it cannot leak
 *      another tenant's row);
 *   3. resolves tenantId + scopes onto `req.apiAuth`;
 *   4. PLAN GATE: asserts the owning tenant is on Premium (assertApiAccessPlan → 403 PLAN_LIMIT)
 *      so a downgraded tenant's keys stop working immediately;
 *   5. best-effort updates lastUsedAt (never blocks the request);
 *   6. runs the rest of the chain INSIDE runWithTenant({ tenantId }) so the Prisma tenant-guard
 *      auto-scopes every downstream query to the key's tenant.
 *
 * Invalid / revoked / expired / malformed → 401 UNAUTHENTICATED. Wrong plan → 403 PLAN_LIMIT.
 */
function extractKey(req: Request): string | null {
  const header = req.header('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) return token.trim();
  const xKey = req.header('x-api-key');
  if (xKey) return xKey.trim();
  return null;
}

export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const presented = extractKey(req);
    if (!presented || !looksLikeApiKey(presented)) {
      return next(Errors.unauthenticated('Missing or malformed API key'));
    }

    const keyHash = hashApiKey(presented);

    // Lookup must run UNSCOPED — there is no tenant context yet. The unique keyHash makes this safe.
    const key = await runUnscoped(() =>
      prisma.apiKey.findUnique({
        where: { keyHash },
        select: {
          id: true,
          tenantId: true,
          scopes: true,
          isActive: true,
          revokedAt: true,
          expiresAt: true,
        },
      }),
    );

    if (!key || !key.isActive || key.revokedAt) {
      return next(Errors.unauthenticated('Invalid or revoked API key'));
    }
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      return next(Errors.unauthenticated('API key has expired'));
    }

    // PLAN GATE — the key only works while the tenant is Premium (PRD Modul 22). Throws 403
    // PLAN_LIMIT_EXCEEDED otherwise, so downgrading disables every key.
    await assertApiAccessPlan(key.tenantId);

    const scopes = Array.isArray(key.scopes) ? (key.scopes as string[]) : [];
    req.apiAuth = { apiKeyId: key.id, tenantId: key.tenantId, scopes };

    // Best-effort lastUsedAt bump — never blocks/fails the request.
    runUnscoped(() =>
      prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }),
    ).catch(() => {
      /* ignore */
    });

    // Run the rest of the request inside the tenant context so the Prisma guard auto-scopes.
    tenantStorage.run({ tenantId: key.tenantId }, () => next());
  } catch (e) {
    next(e);
  }
}

/**
 * Scope gate (PRD Modul 22). requireScope('invoices:read') → 403 FORBIDDEN when the key's scopes
 * do not include the required scope. Must run after apiKeyAuth.
 */
export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.apiAuth) return next(Errors.unauthenticated('API key required'));
    if (!req.apiAuth.scopes.includes(scope)) {
      return next(Errors.forbidden(`This API key is missing the required scope: ${scope}`));
    }
    next();
  };
}
