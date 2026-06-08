import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import { getRoomPropertyId } from '../rooms/rooms.service';
import * as svc from './meters.service';
import type { ListMeterReadingQuery } from './meters.validators';

// ── Nested under /rooms/:id/meter-readings ──
async function guardRoom(req: Request) {
  const propertyId = await getRoomPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
  return propertyId;
}

export async function listByRoom(req: Request, res: Response) {
  await guardRoom(req);
  const q = vquery<ListMeterReadingQuery>(req);
  const { rows, total } = await svc.listReadingsByRoom(req.params.id, q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function createForRoom(req: Request, res: Response) {
  await guardRoom(req);
  const created = await svc.createReading(
    req.auth!.tenantId,
    req.params.id,
    req.auth!.userId,
    req.body,
  );
  await writeAudit(req, {
    action: 'meter.create',
    entityType: 'meter_reading',
    entityId: created.id,
    newValue: created,
  });
  return ok(res, created, 201);
}

// ── Direct /meter-readings/:id ──
async function guardReading(req: Request) {
  const propertyId = await svc.getReadingPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function update(req: Request, res: Response) {
  await guardReading(req);
  const updated = await svc.updateReading(req.params.id, req.body);
  await writeAudit(req, {
    action: 'meter.update',
    entityType: 'meter_reading',
    entityId: updated.id,
    newValue: updated,
  });
  return ok(res, updated);
}

export async function remove(req: Request, res: Response) {
  await guardReading(req);
  const result = await svc.deleteReading(req.params.id);
  await writeAudit(req, {
    action: 'meter.delete',
    entityType: 'meter_reading',
    entityId: req.params.id,
  });
  return ok(res, result);
}
