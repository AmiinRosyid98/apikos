import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import { runWithTenant } from '../../config/tenantStore';
import { getPaymentProvider } from './providers/factory';
import * as svc from './payment-gateway.service';
import type { ListTxnQuery, ReconciliationQuery } from './payments.validators';

// ── Create charge: POST /invoices/:id/charge (Admin+) ──
export async function createCharge(req: Request, res: Response) {
  const propertyId = await svc.getTxnInvoicePropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
  const txn = await svc.createCharge(req.auth!.tenantId, req.params.id, req.body.method);
  await writeAudit(req, {
    action: 'payment_gateway.charge',
    entityType: 'payment_gateway_txn',
    entityId: txn.id,
    newValue: { invoiceId: req.params.id, method: txn.method, amount: txn.amount, provider: txn.provider },
  });
  return ok(res, txn, 201);
}

// ── List charges for an invoice: GET /invoices/:id/charges (All) ──
export async function listInvoiceCharges(req: Request, res: Response) {
  const propertyId = await svc.getTxnInvoicePropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
  const rows = await svc.listInvoiceCharges(req.params.id);
  return ok(res, rows);
}

// ── List all txns: GET /payment-txns (owner/manager/finance) ──
export async function listTxns(req: Request, res: Response) {
  const q = vquery<ListTxnQuery>(req);
  const { rows, total } = await svc.listTxns(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

// ── Simulate: POST /payment-txns/:id/simulate (owner/admin, stub-only) ──
export async function simulate(req: Request, res: Response) {
  const propertyId = await svc.getTxnPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
  const outcome = (req.body?.outcome ?? 'paid') as 'paid' | 'failed' | 'expired';
  const result = await svc.simulateTxn(req.params.id, outcome);
  await writeAudit(req, {
    action: 'payment_gateway.simulate',
    entityType: 'payment_gateway_txn',
    entityId: req.params.id,
    newValue: { outcome, status: result.status, paymentId: result.paymentId ?? null },
  });
  return ok(res, result);
}

// ── Reconciliation: GET /payments/reconciliation (owner/manager/finance) ──
export async function reconciliation(req: Request, res: Response) {
  const q = vquery<ReconciliationQuery>(req);
  if (q.property_id) assertPropertyAccess(req, q.property_id);
  const data = await svc.reconcile(q, req.propertyScope);
  return ok(res, data);
}

// ── Method availability: GET /payments/methods (All) ──
export async function methods(req: Request, res: Response) {
  const data = await svc.getAllowedMethods(req.auth!.tenantId);
  return ok(res, data);
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// PUBLIC webhook: POST /webhooks/payment (no auth — mounted OUTSIDE the protected router).
// Verified via provider.verifyWebhook. Resolves the txn's tenant, then applies the webhook inside
// that tenant's guard context. ALWAYS responds 200 (even on ignore/unknown) so the provider does
// not retry forever on a webhook we deliberately no-op.
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function webhook(req: Request, res: Response) {
  const provider = getPaymentProvider();
  const headers = req.headers as Record<string, string | undefined>;
  const verified = await provider.verifyWebhook(req.body, headers);
  if (!verified) {
    // Bad signature / unparseable / non-actionable status → acknowledge without acting.
    return ok(res, { handled: false, reason: 'ignored (unverified or non-actionable)' });
  }

  const tenantId = await svc.resolveTxnTenant(verified.providerRef);
  if (!tenantId) {
    return ok(res, { handled: false, reason: 'unknown providerRef' });
  }

  const outcome = await runWithTenant({ tenantId }, () => svc.applyVerifiedWebhook(verified));
  return ok(res, outcome);
}
