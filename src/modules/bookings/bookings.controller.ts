import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import * as svc from './bookings.service';
import type { ListBookingQuery } from './bookings.validators';

/** Resolve + assert property-scope access for an existing booking. */
async function guardBooking(req: Request) {
  const propertyId = await svc.getBookingPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function list(req: Request, res: Response) {
  const q = vquery<ListBookingQuery>(req);
  const { rows, total } = await svc.listBookings(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function detail(req: Request, res: Response) {
  await guardBooking(req);
  const data = await svc.getBookingDetail(req.params.id);
  return ok(res, data);
}

export async function create(req: Request, res: Response) {
  // Resolve the room → property up front so property-scope is enforced before any write.
  const room = await prisma.room.findFirst({ where: { id: req.body.roomId } });
  if (!room) throw Errors.notFound('Room not found');
  assertPropertyAccess(req, room.propertyId);

  const created = await svc.createBooking(req.auth!.tenantId, req.auth!.userId, req.body);
  await writeAudit(req, {
    action: 'booking.create',
    entityType: 'booking',
    entityId: created.id,
    newValue: {
      id: created.id,
      roomId: created.roomId,
      prospectName: created.prospectName,
      status: created.status,
    },
  });
  return ok(res, created, 201);
}

export async function confirm(req: Request, res: Response) {
  await guardBooking(req);
  const updated = await svc.confirmBooking(req.params.id);
  await writeAudit(req, {
    action: 'booking.confirm',
    entityType: 'booking',
    entityId: updated.id,
    newValue: { status: updated.status, feeStatus: updated.feeStatus },
  });
  return ok(res, updated);
}

export async function convert(req: Request, res: Response) {
  await guardBooking(req);
  const result = await svc.convertBooking(req.auth!.tenantId, req.params.id, req.body);
  await writeAudit(req, {
    action: 'booking.convert',
    entityType: 'booking',
    entityId: result.booking.id,
    newValue: {
      status: result.booking.status,
      convertedResidentId: result.residentId,
      firstInvoice: result.firstInvoice ?? null,
    },
  });
  return ok(res, result);
}

export async function cancel(req: Request, res: Response) {
  await guardBooking(req);
  const updated = await svc.cancelBooking(req.params.id, req.body);
  await writeAudit(req, {
    action: 'booking.cancel',
    entityType: 'booking',
    entityId: updated.id,
    newValue: { status: updated.status },
  });
  return ok(res, updated);
}
