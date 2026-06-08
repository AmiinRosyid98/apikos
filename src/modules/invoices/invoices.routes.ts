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
  loadPropertyScope,
} from '../../middleware/rbacGuard';
import {
  generateInvoiceSchema,
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
router.post('/', rbacGuard(ADMIN_PLUS), validate(createInvoiceSchema), asyncHandler(ctrl.createManual));
router.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.detail));
router.put('/:id', rbacGuard(OWNER_MANAGER), validate(updateInvoiceSchema), asyncHandler(ctrl.update));
router.post('/:id/payment', rbacGuard(ALL), validate(recordPaymentSchema), asyncHandler(ctrl.recordPayment));
router.post('/:id/mark-paid', rbacGuard(FINANCE_PLUS), validate(markPaidSchema), asyncHandler(ctrl.markPaid));
router.patch('/:id/cancel', rbacGuard(OWNER_MANAGER), validate(cancelInvoiceSchema), asyncHandler(ctrl.cancel));

export default router;
