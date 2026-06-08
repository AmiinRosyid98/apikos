import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { writeAudit } from '../../services/audit.service';
import * as svc from './users.service';
import type { ListUserQuery } from './users.validators';

export async function list(req: Request, res: Response) {
  const q = vquery<ListUserQuery>(req);
  const { rows, total } = await svc.listUsers(q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function invite(req: Request, res: Response) {
  const result = await svc.inviteUser(req.auth!.tenantId, req.auth!.userId, req.body);
  await writeAudit(req, {
    action: 'user.invite',
    entityType: 'user',
    entityId: result.id,
    newValue: { email: result.email, role: result.role },
  });
  return ok(res, result, 201);
}

export async function acceptInvite(req: Request, res: Response) {
  const result = await svc.acceptInvite(req.body.token, req.body.password);
  return ok(res, result);
}

export async function detail(req: Request, res: Response) {
  const data = await svc.getUser(req.params.id);
  return ok(res, data);
}

export async function changeRole(req: Request, res: Response) {
  const updated = await svc.changeRole(req.params.id, req.body.role);
  await writeAudit(req, {
    action: 'user.role',
    entityType: 'user',
    entityId: updated.id,
    newValue: { role: updated.role },
  });
  return ok(res, updated);
}

export async function propertyAccess(req: Request, res: Response) {
  const updated = await svc.setPropertyAccess(req.auth!.tenantId, req.params.id, req.body.propertyIds);
  await writeAudit(req, {
    action: 'user.property_access',
    entityType: 'user',
    entityId: updated.id,
    newValue: { propertyAccess: updated.propertyAccess },
  });
  return ok(res, updated);
}

export async function deactivate(req: Request, res: Response) {
  const updated = await svc.setActive(req.params.id, req.body.is_active);
  await writeAudit(req, {
    action: 'user.deactivate',
    entityType: 'user',
    entityId: updated.id,
    newValue: { isActive: updated.isActive },
  });
  return ok(res, updated);
}
