import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { Errors } from '../../utils/errors';

import {
  listProperties,
  getPropertyWithStats,
} from '../properties/properties.service';
import { listRooms, getRoomWithHistory } from '../rooms/rooms.service';
import { listResidents, getResidentDetail } from '../residents/residents.service';
import { listInvoices, getInvoiceDetail } from '../invoices/invoices.service';
import {
  listBookings,
  getBookingDetail,
  createBooking,
} from '../bookings/bookings.service';

import type {
  ExtListQuery,
  ExtRoomListQuery,
  ExtResidentListQuery,
  ExtInvoiceListQuery,
  ExtBookingListQuery,
} from './external.validators';
import type { CreateBookingInput } from '../bookings/bookings.validators';

/**
 * Public API controllers (PRD Modul 22). Every handler runs inside runWithTenant (set by
 * apiKeyAuth), so the underlying services auto-scope to the key's tenant. Read services are
 * called with `scope = undefined` (full tenant access — API keys are tenant-level, not
 * property-restricted). Residents NEVER expose decrypted NIK (masked nikLast4 only).
 */

// GET /me — connectivity + scope/tenant introspection.
export async function me(req: Request, res: Response) {
  return ok(res, {
    apiKeyId: req.apiAuth!.apiKeyId,
    tenantId: req.apiAuth!.tenantId,
    scopes: req.apiAuth!.scopes,
  });
}

// ---- Properties (properties:read) -----------------------------------------
export async function listPropertiesExt(req: Request, res: Response) {
  const q = vquery<ExtListQuery>(req);
  const { rows, total } = await listProperties(
    { ...q, type: undefined, city: undefined, is_active: undefined, sort_by: undefined } as any,
    undefined,
  );
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function getPropertyExt(req: Request, res: Response) {
  const data = await getPropertyWithStats(req.params.id);
  return ok(res, data);
}

// ---- Rooms (rooms:read) ---------------------------------------------------
export async function listRoomsExt(req: Request, res: Response) {
  const q = vquery<ExtRoomListQuery>(req);
  const { rows, total } = await listRooms(q as any);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function getRoomExt(req: Request, res: Response) {
  const data = await getRoomWithHistory(req.params.id);
  return ok(res, data);
}

// ---- Residents (residents:read) — NIK ALWAYS MASKED -----------------------
export async function listResidentsExt(req: Request, res: Response) {
  const q = vquery<ExtResidentListQuery>(req);
  const { rows, total } = await listResidents(q as any, undefined);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function getResidentExt(req: Request, res: Response) {
  // canSeeRawNik = false → the external API NEVER decrypts NIK/KTP (masked nikLast4 only).
  const data = await getResidentDetail(req.params.id, false);
  return ok(res, data);
}

// ---- Invoices (invoices:read) ---------------------------------------------
export async function listInvoicesExt(req: Request, res: Response) {
  const q = vquery<ExtInvoiceListQuery>(req);
  const { rows, total } = await listInvoices(q as any, undefined);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function getInvoiceExt(req: Request, res: Response) {
  const data = await getInvoiceDetail(req.params.id);
  return ok(res, data);
}

// ---- Bookings (bookings:read / bookings:write) ----------------------------
export async function listBookingsExt(req: Request, res: Response) {
  const q = vquery<ExtBookingListQuery>(req);
  const { rows, total } = await listBookings(q as any, undefined);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function getBookingExt(req: Request, res: Response) {
  const data = await getBookingDetail(req.params.id);
  return ok(res, data);
}

export async function createBookingExt(req: Request, res: Response) {
  if (!req.apiAuth) throw Errors.unauthenticated('API key required');
  // recordedByUserId is null for API-created bookings (no dashboard user); the service accepts
  // a userId — we pass the special API marker via null-safe undefined → stored as null.
  const created = await createBooking(
    req.apiAuth.tenantId,
    // bookings.createBooking sets recordedByUserId from this arg; API bookings have no user.
    (undefined as unknown) as string,
    req.body as CreateBookingInput,
  );
  return ok(res, created, 201);
}
