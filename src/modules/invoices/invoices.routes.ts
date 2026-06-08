import { Router } from 'express';
import * as ctrl from './invoices.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  rbacGuard,
  ALL,
  ADMIN_PLUS,
  FINANCE_PLUS,
  OWNER_MANAGER,
  OWNER_ONLY,
  loadPropertyScope,
} from '../../middleware/rbacGuard';
import {
  generateInvoiceSchema,
  generateRunSchema,
  createInvoiceSchema,
  updateInvoiceSchema,
  recordPaymentSchema,
  markPaidSchema,
  cancelInvoiceSchema,
  listInvoiceQuery,
} from './invoices.validators';

const router = Router();
router.use(loadPropertyScope);

router.get('/', rbacGuard(ALL), validate(listInvoiceQuery, 'query'), asyncHandler(ctrl.list));
router.post('/generate', rbacGuard(ADMIN_PLUS), validate(generateInvoiceSchema), asyncHandler(ctrl.generate));
// Owner-only: enqueue a scheduled-style run (same code path as the daily cron) for testing/ops.
router.post('/generate-run', rbacGuard(OWNER_ONLY), validate(generateRunSchema), asyncHandler(ctrl.generateRun));
router.post('/', rbacGuard(ADMIN_PLUS), validate(createInvoiceSchema), asyncHandler(ctrl.createManual));
router.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.detail));
router.put('/:id', rbacGuard(OWNER_MANAGER), validate(updateInvoiceSchema), asyncHandler(ctrl.update));
router.post('/:id/payment', rbacGuard(ALL), validate(recordPaymentSchema), asyncHandler(ctrl.recordPayment));
router.post('/:id/mark-paid', rbacGuard(FINANCE_PLUS), validate(markPaidSchema), asyncHandler(ctrl.markPaid));
router.patch('/:id/cancel', rbacGuard(OWNER_MANAGER), validate(cancelInvoiceSchema), asyncHandler(ctrl.cancel));

export default router;
