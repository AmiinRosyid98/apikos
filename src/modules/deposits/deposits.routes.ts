import { Router } from 'express';
import * as ctrl from './deposits.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  rbacGuard,
  ALL,
  ADMIN_PLUS,
  MANAGER_PLUS,
  FINANCE_PLUS,
  loadPropertyScope,
} from '../../middleware/rbacGuard';
import {
  createDepositSchema,
  refundDepositSchema,
  listDepositsByResidentQuery,
  listDepositsReportQuery,
} from './deposits.validators';

// ── Nested router for /api/v1/residents/:id/deposits (mergeParams to read :id) ──
export const residentDepositsRouter = Router({ mergeParams: true });
residentDepositsRouter.use(loadPropertyScope);

residentDepositsRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listDepositsByResidentQuery, 'query'),
  asyncHandler(ctrl.listByResident),
);
residentDepositsRouter.post(
  '/',
  rbacGuard(ADMIN_PLUS),
  validate(createDepositSchema),
  asyncHandler(ctrl.createForResident),
);
residentDepositsRouter.post(
  '/:depId/refund',
  rbacGuard(MANAGER_PLUS),
  validate(refundDepositSchema),
  asyncHandler(ctrl.refund),
);

// ── Direct router for /api/v1/deposits (outstanding report) ──
export const depositsRouter = Router();
depositsRouter.use(loadPropertyScope);
depositsRouter.get(
  '/',
  rbacGuard(FINANCE_PLUS),
  validate(listDepositsReportQuery, 'query'),
  asyncHandler(ctrl.report),
);
