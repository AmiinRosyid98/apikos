import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess, ADMIN_PLUS, MANAGER_PLUS } from '../../middleware/rbacGuard';
import { Errors } from '../../utils/errors';
import { writeAudit } from '../../services/audit.service';
import * as svc from './handovers.service';
import { generateHandoverPdf } from './handovers.pdf';
import type { ListHandoversByResidentQuery } from './handovers.validators';

// ── Nested under /residents/:id/handovers ──
async function guardResident(req: Request) {
  const propertyId = await svc.getResidentPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function listByResident(req: Request, res: Response) {
  await guardResident(req);
  const q = vquery<ListHandoversByResidentQuery>(req);
  const { rows, total } = await svc.listByResident(req.params.id, q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

/**
 * Create a handover. Role is gated by `type`: check-in = Admin+, check-out = Manager+.
 * We enforce the per-type role here (after the route-level ADMIN_PLUS gate) because the
 * requirement is type-dependent.
 */
export async function createForResident(req: Request, res: Response) {
  await guardResident(req);
  const type = req.body.type as 'checkin' | 'checkout';
  if (type === 'checkout' && !MANAGER_PLUS.includes(req.auth!.role)) {
    throw Errors.forbidden('Only Manager+ (owner/manager) may record a check-out handover');
  }
  if (type === 'checkin' && !ADMIN_PLUS.includes(req.auth!.role)) {
    throw Errors.forbidden('Only Admin+ (owner/manager/admin) may record a check-in handover');
  }

  const result = await svc.createHandover(
    req.auth!.tenantId,
    req.params.id,
    req.auth!.userId,
    req.body,
  );
  await writeAudit(req, {
    action: 'handover.create',
    entityType: 'handover_record',
    entityId: result.handover.id,
    newValue: {
      id: result.handover.id,
      type: result.handover.type,
      date: result.handover.date,
      meterSeeded: result.meterSeeded,
    },
  });
  return ok(res, result, 201);
}

// ── Direct /handovers/:id ──
async function guardHandover(req: Request) {
  const propertyId = await svc.getHandoverPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function detail(req: Request, res: Response) {
  await guardHandover(req);
  const data = await svc.getHandoverDetail(req.params.id);
  return ok(res, data);
}

export async function pdf(req: Request, res: Response) {
  await guardHandover(req);
  const ctx = await svc.getHandoverForPdf(req.params.id);
  const buffer = await generateHandoverPdf(ctx);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader(
    'Content-Disposition',
    `inline; filename="berita-acara-${ctx.handover.type}-${ctx.handover.id}.pdf"`,
  );
  return res.status(200).end(buffer);
}
