import { Router } from 'express';
import * as ctrl from './payments.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  rbacGuard,
  ALL,
  ADMIN_PLUS,
  FINANCE_PLUS,
  loadPropertyScope,
} from '../../middleware/rbacGuard';
import {
  createChargeSchema,
  simulateSchema,
  listTxnQuery,
  reconciliationQuery,
} from './payments.validators';

/**
 * Payment Gateway routes (PRD §6.8, STUB mode). RBAC (PRD §13):
 *   - Create charge (catat pembayaran via gateway): Admin+ (owner/manager/admin)
 *   - View gateway txns / reconciliation: owner/manager/finance (reconciliation EXCLUDES admin)
 *   - Simulate (stub-only dev convenience): owner/admin
 *   - Method availability: All
 *   - Webhook: PUBLIC (mounted OUTSIDE the protected router — see webhookRouter below)
 *
 * STUB MODE: txns are created and "paid" via the simulate/webhook path with NO real money (provider
 * seam — see providers/). Set MIDTRANS_SERVER_KEY to switch to the real provider (config-only).
 */

// ── /payment-txns (+ simulate) and /payments/* ──
const paymentsRouter = Router();
paymentsRouter.use(loadPropertyScope);

// Method availability (All) — single source of truth for the UI (replaces the misleading boolean).
paymentsRouter.get('/methods', rbacGuard(ALL), asyncHandler(ctrl.methods));

// Reconciliation (owner/manager/finance — admin excluded per §13).
paymentsRouter.get(
  '/reconciliation',
  rbacGuard(FINANCE_PLUS),
  validate(reconciliationQuery, 'query'),
  asyncHandler(ctrl.reconciliation),
);

// ── /payment-txns (list + simulate) ──
const txnsRouter = Router();
txnsRouter.use(loadPropertyScope);
txnsRouter.get(
  '/',
  rbacGuard(FINANCE_PLUS),
  validate(listTxnQuery, 'query'),
  asyncHandler(ctrl.listTxns),
);
// Simulate (stub-only): owner/admin. Use OWNER + ADMIN explicitly (NOT manager).
txnsRouter.post(
  '/:id/simulate',
  rbacGuard(['owner', 'admin']),
  validate(simulateSchema),
  asyncHandler(ctrl.simulate),
);

// ── PUBLIC webhook router — mounted OUTSIDE the protected (auth) router ──
const webhookRouter = Router();
webhookRouter.post('/payment', asyncHandler(ctrl.webhook));

// ── Invoice-scoped charge routes — registered ON the invoices router (see invoices.routes.ts) so
// they never shadow /invoices/generate. Exported as handlers for that router to wire. ──
export const invoiceChargeRoutes = {
  create: [rbacGuard(ADMIN_PLUS), validate(createChargeSchema), asyncHandler(ctrl.createCharge)],
  list: [rbacGuard(ALL), asyncHandler(ctrl.listInvoiceCharges)],
};

export { paymentsRouter, txnsRouter, webhookRouter };
