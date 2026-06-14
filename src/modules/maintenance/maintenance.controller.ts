import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import { getRoomPropertyId } from '../rooms/rooms.service';
import * as svc from './maintenance.service';
import type {
  ListTicketQuery,
  ListVendorQuery,
  RoomMaintenanceQuery,
} from './maintenance.validators';

// ─────────────────────────── Tickets ───────────────────────────
async function guardTicket(req: Request) {
  const propertyId = await svc.getTicketPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function listTickets(req: Request, res: Response) {
  const q = vquery<ListTicketQuery>(req);
  const { rows, total } = await svc.listTickets(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function ticketDetail(req: Request, res: Response) {
  await guardTicket(req);
  const data = await svc.getTicketDetail(req.params.id);
  return ok(res, data);
}

export async function createTicket(req: Request, res: Response) {
  // Resolve property-scope up front (and validate the room→property if a room is supplied).
  assertPropertyAccess(req, req.body.propertyId);

  const created = await svc.createTicket(req.auth!.tenantId, req.auth!.userId, req.body);
  await writeAudit(req, {
    action: 'maintenance.create',
    entityType: 'maintenance_ticket',
    entityId: created.id,
    newValue: {
      id: created.id,
      ticketNumber: created.ticketNumber,
      title: created.title,
      status: created.status,
      priority: created.priority,
      roomId: created.roomId,
    },
  });
  return ok(res, created, 201);
}

export async function updateTicket(req: Request, res: Response) {
  await guardTicket(req);
  const updated = await svc.updateTicket(
    req.auth!.tenantId,
    req.auth!.userId,
    req.params.id,
    req.body,
  );
  await writeAudit(req, {
    action: 'maintenance.update',
    entityType: 'maintenance_ticket',
    entityId: updated.id,
    newValue: {
      vendorId: updated.vendorId,
      cost: updated.cost,
      priority: updated.priority,
      expenseId: updated.expenseId,
    },
  });
  return ok(res, updated);
}

export async function changeStatus(req: Request, res: Response) {
  await guardTicket(req);
  const updated = await svc.changeStatus(
    req.auth!.tenantId,
    req.auth!.userId,
    req.params.id,
    req.body,
  );
  await writeAudit(req, {
    action: 'maintenance.status',
    entityType: 'maintenance_ticket',
    entityId: updated.id,
    newValue: {
      status: updated.status,
      resolvedAt: updated.resolvedAt,
      cost: updated.cost,
      expenseId: updated.expenseId,
    },
  });
  return ok(res, updated);
}

// ── Per-room history: GET /rooms/:id/maintenance ──
export async function listTicketsByRoom(req: Request, res: Response) {
  const propertyId = await getRoomPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
  const q = vquery<RoomMaintenanceQuery>(req);
  const { rows, total, totalCost } = await svc.listTicketsByRoom(req.params.id, q);
  return okPaged(res, rows, { ...buildMeta(q.page, q.limit, total), totalCost } as never);
}

// ─────────────────────────── Vendors ───────────────────────────
// Vendors are tenant-level (not property-scoped); the Prisma tenant-guard handles isolation.
export async function listVendors(req: Request, res: Response) {
  const q = vquery<ListVendorQuery>(req);
  const { rows, total } = await svc.listVendors(q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function vendorDetail(req: Request, res: Response) {
  const data = await svc.getVendorDetail(req.params.id);
  return ok(res, data);
}

export async function createVendor(req: Request, res: Response) {
  const created = await svc.createVendor(req.auth!.tenantId, req.body);
  await writeAudit(req, {
    action: 'vendor.create',
    entityType: 'vendor',
    entityId: created.id,
    newValue: { id: created.id, name: created.name, skill: created.skill },
  });
  return ok(res, created, 201);
}

export async function updateVendor(req: Request, res: Response) {
  const updated = await svc.updateVendor(req.params.id, req.body);
  await writeAudit(req, {
    action: 'vendor.update',
    entityType: 'vendor',
    entityId: updated.id,
    newValue: { name: updated.name, skill: updated.skill, isActive: updated.isActive },
  });
  return ok(res, updated);
}

export async function deleteVendor(req: Request, res: Response) {
  const result = await svc.deleteVendor(req.params.id);
  await writeAudit(req, {
    action: 'vendor.delete',
    entityType: 'vendor',
    entityId: req.params.id,
    newValue: { mode: result.mode },
  });
  return ok(res, result);
}
