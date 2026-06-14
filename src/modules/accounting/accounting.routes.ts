import { Router } from 'express';
import * as ctrl from './accounting.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, FINANCE_PLUS, OWNER_ONLY, loadPropertyScope } from '../../middleware/rbacGuard';
import { updateConfigSchema, syncSchema, listEntriesQuery } from './accounting.validators';

/**
 * Integrasi Akuntansi routes (PRD Modul 21 — Premium-only, STUB MODE). Mounted on the JWT-protected
 * router at /accounting. RBAC (PRD §13, mirrors finance/P&L — admin EXCLUDED from finance views):
 *   - GET  /accounting/status   → owner/manager/finance
 *   - PUT  /accounting/config   → Owner-only + Premium-gated (assertPlanFeature('accountingIntegration'))
 *   - POST /accounting/sync     → owner/manager/finance (property-scope aware)
 *   - GET  /accounting/entries  → owner/manager/finance
 *
 * STUB MODE: no real API calls — the StubProvider returns a fake JRN-STUB-… ref. Set a tenant's
 * provider='jurnal'|'accurate' + an (encrypted) key to switch to the real provider (config-only).
 */
const accountingRouter = Router();
accountingRouter.use(loadPropertyScope);

accountingRouter.get('/status', rbacGuard(FINANCE_PLUS), asyncHandler(ctrl.status));

accountingRouter.put(
  '/config',
  rbacGuard(OWNER_ONLY),
  validate(updateConfigSchema),
  asyncHandler(ctrl.updateConfig),
);

accountingRouter.post(
  '/sync',
  rbacGuard(FINANCE_PLUS),
  validate(syncSchema),
  asyncHandler(ctrl.sync),
);

accountingRouter.get(
  '/entries',
  rbacGuard(FINANCE_PLUS),
  validate(listEntriesQuery, 'query'),
  asyncHandler(ctrl.listEntries),
);

export { accountingRouter };
