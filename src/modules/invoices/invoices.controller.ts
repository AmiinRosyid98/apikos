import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import { enqueueInvoiceRun } from '../../jobs/queue';
import * as svc from './invoices.service';
import type { ListInvoiceQuery } from './invoices.validators';

export async function list(req: Request, res: Response) {
  const q = vquery<ListInvoiceQuery>(req);
  const { rows, total } = await svc.listInvoices(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function generate(req: Request, res: Response) {
  assertPropertyAccess(req, req.body.propertyId);
  const result = await svc.generateInvoices(req.auth!.tenantId, req.body);
  await writeAudit(req, {
    action: 'invoice.generate',
    entityType: 'invoice',
    entityId: req.body.propertyId,
    newValue: { created: result.created, skipped: result.skipped },
  });
  return ok(res, result, 201);
}

/**
 * Owner-only on-demand trigger that enqueues a scheduled-style invoice-generation run for
 * the caller's tenant (same code path as the daily cron). Useful for testing/operations
 * without waiting for 00:30 WIB. Returns the enqueued BullMQ job id; the worker performs the
 * actual generation. Requires the worker process to be running.
 */
export async function generateRun(req: Request, res: Response) {
  const jobId = await enqueueInvoiceRun({
    tenantId: req.auth!.tenantId,
    asOf: req.body?.asOf,
    source: 'admin-trigger',
  });
  await writeAudit(req, {
    action: 'invoice.generate_run',
    entityType: 'invoice',
    entityId: req.auth!.tenantId,
    newValue: { jobId, asOf: req.body?.asOf ?? null },
  });
  return ok(res, { jobId, enqueued: true }, 202);
}

export async function createManual(req: Request, res: Response) {
  const created = await svc.createManualInvoice(req.auth!.tenantId, req.body);
  await writeAudit(req, {
    action: 'invoice.create',
    entityType: 'invoice',
    entityId: created.id,
    newValue: { invoiceNumber: created.invoiceNumber, total: created.totalAmount },
  });
  return ok(res, created, 201);
}

async function guard(req: Request) {
  const propertyId = await svc.getInvoicePropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function detail(req: Request, res: Response) {
  await guard(req);
  const data = await svc.getInvoiceDetail(req.params.id);
  return ok(res, data);
}

export async function update(req: Request, res: Response) {
  await guard(req);
  const updated = await svc.updateInvoice(req.params.id, req.body);
  await writeAudit(req, {
    action: 'invoice.update',
    entityType: 'invoice',
    entityId: updated.id,
    newValue: { total: updated.totalAmount },
  });
  return ok(res, updated);
}

export async function recordPayment(req: Request, res: Response) {
  await guard(req);
  const payment = await svc.recordPayment(req.params.id, req.auth!.userId, req.body);
  await writeAudit(req, {
    action: 'payment.record',
    entityType: 'payment',
    entityId: payment.id,
    newValue: { invoiceId: payment.invoiceId, amount: payment.amount },
  });
  return ok(res, payment, 201);
}

export async function markPaid(req: Request, res: Response) {
  await guard(req);
  const updated = await svc.markPaid(req.params.id, req.auth!.userId, req.body.method, req.body.paidAt);
  await writeAudit(req, {
    action: 'invoice.mark_paid',
    entityType: 'invoice',
    entityId: updated.id,
    newValue: { status: updated.status },
  });
  return ok(res, updated);
}

export async function cancel(req: Request, res: Response) {
  await guard(req);
  const updated = await svc.cancelInvoice(req.params.id, req.body.reason);
  await writeAudit(req, {
    action: 'invoice.cancel',
    entityType: 'invoice',
    entityId: updated.id,
    newValue: { status: updated.status, reason: req.body.reason },
  });
  return ok(res, updated);
}
