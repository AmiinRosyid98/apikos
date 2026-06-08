import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import * as svc from './rooms.service';
import type { ListRoomQuery } from './rooms.validators';

// ── Nested under /properties/:id/rooms ──
export async function listByProperty(req: Request, res: Response) {
  assertPropertyAccess(req, req.params.id);
  const q = vquery<ListRoomQuery>(req);
  const { rows, total } = await svc.listRoomsByProperty(req.params.id, q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function createInProperty(req: Request, res: Response) {
  assertPropertyAccess(req, req.params.id);
  const created = await svc.createRoom(req.auth!.tenantId, req.params.id, req.body);
  await writeAudit(req, {
    action: 'room.create',
    entityType: 'room',
    entityId: created.id,
    newValue: created,
  });
  return ok(res, created, 201);
}

export async function bulkPrice(req: Request, res: Response) {
  assertPropertyAccess(req, req.params.id);
  const result = await svc.bulkPrice(req.params.id, req.body);
  await writeAudit(req, {
    action: 'room.bulk_price',
    entityType: 'room',
    entityId: req.params.id,
    newValue: result,
  });
  return ok(res, result);
}

// ── Direct /rooms/:id ──
async function guardRoom(req: Request) {
  const propertyId = await svc.getRoomPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function detail(req: Request, res: Response) {
  await guardRoom(req);
  const data = await svc.getRoomWithHistory(req.params.id);
  return ok(res, data);
}

export async function update(req: Request, res: Response) {
  await guardRoom(req);
  const updated = await svc.updateRoom(req.params.id, req.body);
  await writeAudit(req, {
    action: 'room.update',
    entityType: 'room',
    entityId: updated.id,
    newValue: updated,
  });
  return ok(res, updated);
}

export async function setStatus(req: Request, res: Response) {
  await guardRoom(req);
  const updated = await svc.setRoomStatus(req.params.id, req.body.status);
  await writeAudit(req, {
    action: 'room.status',
    entityType: 'room',
    entityId: updated.id,
    newValue: { status: updated.status },
  });
  return ok(res, updated);
}

export async function clone(req: Request, res: Response) {
  await guardRoom(req);
  const created = await svc.cloneRoom(req.auth!.tenantId, req.params.id, req.body);
  await writeAudit(req, {
    action: 'room.clone',
    entityType: 'room',
    entityId: req.params.id,
    newValue: { count: created.length },
  });
  return ok(res, created, 201);
}

export async function addPhotos(req: Request, res: Response) {
  await guardRoom(req);
  const updated = await svc.appendPhotos(req.params.id, req.body.keys);
  await writeAudit(req, {
    action: 'room.photos',
    entityType: 'room',
    entityId: updated.id,
    newValue: { photos: updated.photos },
  });
  return ok(res, updated);
}
