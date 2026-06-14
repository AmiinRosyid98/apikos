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
// WhatsApp: send an invoice via WA (PRD §6.9). The route lives here (not as a separate
// /invoices/:id mount) so it never shadows /invoices/generate. Admin+.
import * as waCtrl from '../whatsapp/whatsapp.controller';
import { sendInvoiceWaSchema } from '../whatsapp/whatsapp.validators';
// Payment Gateway (PRD §6.8): charge an invoice / list its gateway txns. Registered HERE (not a
// separate /invoices/:id mount) so they never shadow /invoices/generate. See payments.routes.ts.
import { invoiceChargeRoutes } from '../payments/payments.routes';

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
// Send this invoice via WhatsApp (PRD §6.9) — Admin+. loadPropertyScope is already applied above.
router.post('/:id/send-wa', rbacGuard(ADMIN_PLUS), validate(sendInvoiceWaSchema), asyncHandler(waCtrl.sendInvoiceWa));
// Payment Gateway (PRD §6.8): create a charge (Admin+) / list this invoice's gateway txns (All).
router.post('/:id/charge', ...invoiceChargeRoutes.create);
router.get('/:id/charges', ...invoiceChargeRoutes.list);

export default router;
