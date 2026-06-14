import { Router, Request, Response } from 'express';
import { ok } from '../../utils/response';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL, OWNER_ONLY } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import { updateBrandingSchema } from './branding.validators';
import { getBranding, updateBranding } from './branding.service';

/**
 * White-label branding (PRD Modul 23 — Premium). Mounted on the JWT-protected router at /branding.
 *
 *  - GET  /branding  → All authenticated roles. Serves { brandName, brandColor, logoUrl } so the
 *                      frontend can theme the app. Returns defaults when unset; plan-independent.
 *  - PUT  /branding  → Owner-only + Premium-gated (service calls assertPlanFeature('whiteLabel') →
 *                      403 on Basic/Pro). Sets/clears brandName, brandColor (#RRGGBB → 422), logoKey.
 *                      Audited `branding.update`.
 *
 * Custom domain is DEFERRED (DNS infra) — no domain route here; see BACKEND_STATUS for the seam.
 */
const brandingRouter = Router();

brandingRouter.get(
  '/',
  rbacGuard(ALL),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await getBranding(req.auth!.tenantId);
    return ok(res, data);
  }),
);

brandingRouter.put(
  '/',
  rbacGuard(OWNER_ONLY),
  validate(updateBrandingSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await updateBranding(req.auth!.tenantId, req.body);
    await writeAudit(req, {
      action: 'branding.update',
      entityType: 'tenant',
      entityId: req.auth!.tenantId,
      newValue: {
        brandName: data.brandName,
        brandColor: data.brandColor,
        logoSet: data.logoUrl !== null,
      },
    });
    return ok(res, data);
  }),
);

export { brandingRouter };
