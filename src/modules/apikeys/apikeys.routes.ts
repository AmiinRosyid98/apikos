import { Router, Request, Response } from 'express';
import { ok } from '../../utils/response';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, OWNER_ONLY } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import { createApiKeySchema } from './apikeys.validators';
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  deleteApiKey,
} from './apikeys.service';

/**
 * API-key MANAGEMENT (dashboard, PRD Modul 22). Mounted on the JWT-protected router at /api-keys.
 * OWNER-ONLY + Premium-gated (the service calls assertPlanFeature('apiAccess') → 403 on Basic/Pro).
 * The secret is shown ONCE in the create response and never again. All mutations are audited.
 */
const apiKeysRouter = Router();

// GET /api-keys — list (prefix + name + scopes + lastUsed + status; NEVER the secret).
apiKeysRouter.get(
  '/',
  rbacGuard(OWNER_ONLY),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await listApiKeys(req.auth!.tenantId);
    return ok(res, data);
  }),
);

// POST /api-keys — create (returns full key ONCE). Premium-only → 403 on Basic/Pro.
apiKeysRouter.post(
  '/',
  rbacGuard(OWNER_ONLY),
  validate(createApiKeySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const created = await createApiKey(req.auth!.tenantId, req.auth!.userId, req.body);
    await writeAudit(req, {
      action: 'api_key.create',
      entityType: 'api_key',
      entityId: created.id,
      newValue: { name: created.name, scopes: created.scopes, keyPrefix: created.keyPrefix },
    });
    return ok(res, created, 201);
  }),
);

// POST /api-keys/:id/revoke — revoke (key stops working immediately).
apiKeysRouter.post(
  '/:id/revoke',
  rbacGuard(OWNER_ONLY),
  asyncHandler(async (req: Request, res: Response) => {
    const updated = await revokeApiKey(req.auth!.tenantId, req.params.id);
    await writeAudit(req, {
      action: 'api_key.revoke',
      entityType: 'api_key',
      entityId: updated.id,
      newValue: { status: updated.status },
    });
    return ok(res, updated);
  }),
);

// DELETE /api-keys/:id — hard delete (optional).
apiKeysRouter.delete(
  '/:id',
  rbacGuard(OWNER_ONLY),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await deleteApiKey(req.auth!.tenantId, req.params.id);
    await writeAudit(req, {
      action: 'api_key.delete',
      entityType: 'api_key',
      entityId: result.id,
    });
    return ok(res, result);
  }),
);

export { apiKeysRouter };
