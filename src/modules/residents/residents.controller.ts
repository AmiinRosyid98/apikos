import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import * as svc from './residents.service';
import type { ListResidentQuery } from './residents.validators';

export async function list(req: Request, res: Response) {
  const q = vquery<ListResidentQuery>(req);
  const { rows, total } = await svc.listResidents(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function create(req: Request, res: Response) {
  assertPropertyAccess(req, req.body.propertyId);
  const created = await svc.createResident(req.body);
  await writeAudit(req, {
    action: 'resident.create',
    entityType: 'resident',
    entityId: created.id,
    newValue: { id: created.id, fullName: created.fullName, roomId: created.roomId },
  });
  return ok(res, created, 201);
}

async function guard(req: Request) {
  const propertyId = await svc.getResidentPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function detail(req: Request, res: Response) {
  await guard(req);
  // PLAN OQ3: Admin+ and finance can view decrypted NIK on detail. Admin role is {owner,manager,admin}.
  const canSeeRawNik = ['owner', 'manager', 'admin', 'finance'].includes(req.auth!.role);
  const data = await svc.getResidentDetail(req.params.id, canSeeRawNik);
  return ok(res, data);
}

export async function update(req: Request, res: Response) {
  await guard(req);
  const updated = await svc.updateResident(req.params.id, req.body);
  await writeAudit(req, {
    action: 'resident.update',
    entityType: 'resident',
    entityId: updated.id,
    newValue: { id: updated.id, fullName: updated.fullName },
  });
  return ok(res, updated);
}

export async function move(req: Request, res: Response) {
  await guard(req);
  const updated = await svc.moveResident(req.params.id, req.body);
  await writeAudit(req, {
    action: 'resident.move',
    entityType: 'resident',
    entityId: updated.id,
    newValue: { roomId: updated.roomId },
  });
  return ok(res, updated);
}

export async function checkout(req: Request, res: Response) {
  await guard(req);
  const updated = await svc.checkoutResident(req.params.id, req.body);
  await writeAudit(req, {
    action: 'resident.checkout',
    entityType: 'resident',
    entityId: updated.id,
    newValue: { status: updated.status, checkOutDate: updated.checkOutDate },
  });
  return ok(res, updated);
}

export async function setStatus(req: Request, res: Response) {
  await guard(req);
  const updated = await svc.setResidentStatus(req.params.id, req.body.status);
  await writeAudit(req, {
    action: 'resident.status',
    entityType: 'resident',
    entityId: updated.id,
    newValue: { status: updated.status },
  });
  return ok(res, updated);
}
