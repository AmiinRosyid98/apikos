import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import * as svc from './properties.service';
import type { ListPropertyQuery } from './properties.validators';

export async function list(req: Request, res: Response) {
  const q = vquery<ListPropertyQuery>(req);
  const { rows, total } = await svc.listProperties(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function create(req: Request, res: Response) {
  const created = await svc.createProperty(req.auth!.tenantId, req.body);
  await writeAudit(req, {
    action: 'property.create',
    entityType: 'property',
    entityId: created.id,
    newValue: created,
  });
  return ok(res, created, 201);
}

export async function detail(req: Request, res: Response) {
  assertPropertyAccess(req, req.params.id);
  const data = await svc.getPropertyWithStats(req.params.id);
  return ok(res, data);
}

export async function update(req: Request, res: Response) {
  assertPropertyAccess(req, req.params.id);
  const updated = await svc.updateProperty(req.params.id, req.body);
  await writeAudit(req, {
    action: 'property.update',
    entityType: 'property',
    entityId: updated.id,
    newValue: updated,
  });
  return ok(res, updated);
}

export async function deactivate(req: Request, res: Response) {
  const result = await svc.deactivateProperty(req.params.id);
  await writeAudit(req, {
    action: 'property.deactivate',
    entityType: 'property',
    entityId: result.id,
    newValue: result,
  });
  return ok(res, result);
}
