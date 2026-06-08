import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import * as svc from './deposits.service';
import type {
  ListDepositsByResidentQuery,
  ListDepositsReportQuery,
} from './deposits.validators';

// ── Nested under /residents/:id/deposits ──
async function guardResident(req: Request) {
  const propertyId = await svc.getResidentPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function listByResident(req: Request, res: Response) {
  await guardResident(req);
  const q = vquery<ListDepositsByResidentQuery>(req);
  const { rows, total } = await svc.listByResident(req.params.id, q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function createForResident(req: Request, res: Response) {
  await guardResident(req);
  const created = await svc.createDeposit(
    req.auth!.tenantId,
    req.params.id,
    req.auth!.userId,
    req.body,
  );
  await writeAudit(req, {
    action: 'deposit.create',
    entityType: 'deposit_record',
    entityId: created.id,
    newValue: created,
  });
  return ok(res, created, 201);
}

export async function refund(req: Request, res: Response) {
  // Guard via the deposit's property.
  const propertyId = await svc.getDepositPropertyId(req.params.depId);
  assertPropertyAccess(req, propertyId);
  // Also confirm the deposit belongs to the resident in the path (consistency).
  const residentPropertyId = await svc.getResidentPropertyId(req.params.id);
  assertPropertyAccess(req, residentPropertyId);

  const updated = await svc.refundDeposit(req.auth!.tenantId, req.params.depId, req.body);
  await writeAudit(req, {
    action: 'deposit.refund',
    entityType: 'deposit_record',
    entityId: updated.id,
    newValue: {
      status: updated.status,
      refundedAmount: updated.refundedAmount,
      deductionAmount: updated.deductionAmount,
      refundedDate: updated.refundedDate,
    },
  });
  return ok(res, updated);
}

// ── Direct /deposits — outstanding report ──
export async function report(req: Request, res: Response) {
  const q = vquery<ListDepositsReportQuery>(req);
  const { rows, total, totalAmount } = await svc.listReport(q, req.propertyScope);
  // Envelope carries the report rows + a summary totalAmount; meta holds pagination.
  return res.status(200).json({
    success: true,
    data: { deposits: rows, totalAmount, status: q.status ?? 'held' },
    meta: buildMeta(q.page, q.limit, total),
  });
}
