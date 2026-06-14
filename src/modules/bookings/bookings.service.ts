import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, dateOnly, iso } from '../../utils/serialize';
import { encryptNullable } from '../../utils/crypto';
import { generateInvoices } from '../invoices/invoices.service';
import { notify } from '../../services/notification.service';
import type {
  CreateBookingInput,
  ConvertBookingInput,
  CancelBookingInput,
  ListBookingQuery,
} from './bookings.validators';

type BookingRow = Prisma.BookingGetPayload<object>;

/** Bookings that still hold a room (block re-booking + are subject to auto-release). */
export const ACTIVE_BOOKING_STATUSES: BookingRow['status'][] = ['pending', 'confirmed'];

/** Default booking-fee deadline: now + 24h (PRD §6.13). */
const DEFAULT_FEE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function serializeBooking(b: BookingRow) {
  return {
    id: b.id,
    propertyId: b.propertyId,
    roomId: b.roomId,
    prospectName: b.prospectName,
    prospectPhone: b.prospectPhone,
    prospectEmail: b.prospectEmail,
    plannedCheckInDate: dateOnly(b.plannedCheckInDate),
    bookingFeeAmount: dec(b.bookingFeeAmount),
    bookingFeeMethod: b.bookingFeeMethod,
    feeStatus: b.feeStatus,
    feeDueAt: iso(b.feeDueAt),
    status: b.status,
    source: b.source,
    message: b.message,
    convertedResidentId: b.convertedResidentId,
    notes: b.notes,
    recordedByUserId: b.recordedByUserId,
    createdAt: iso(b.createdAt),
    updatedAt: iso(b.updatedAt),
  };
}

async function getBooking(id: string): Promise<BookingRow> {
  const b = await prisma.booking.findFirst({ where: { id } });
  if (!b) throw Errors.notFound('Booking not found');
  return b;
}

/** Resolve the property a booking belongs to (for property-scope access checks). */
export async function getBookingPropertyId(id: string): Promise<string> {
  return (await getBooking(id)).propertyId;
}

export async function listBookings(q: ListBookingQuery, scope: string[] | undefined) {
  const where: Prisma.BookingWhereInput = {};
  if (q.status) where.status = q.status;
  if (q.room_id) where.roomId = q.room_id;
  if (q.property_id) where.propertyId = q.property_id;
  // Property-scope restriction (manager/admin/finance limited to user_property_access).
  if (scope !== undefined) {
    where.propertyId =
      q.property_id && scope.includes(q.property_id)
        ? q.property_id
        : { in: q.property_id ? ['__none__'] : scope };
  }

  const [rows, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.booking.count({ where }),
  ]);
  return { rows: rows.map(serializeBooking), total };
}

export async function getBookingDetail(id: string) {
  return serializeBooking(await getBooking(id));
}

/**
 * Create an INTERNAL booking. Validations:
 *   - room must exist (404)
 *   - room must be `empty` (409 — occupied/booking/maintenance/renovation cannot be booked)
 *   - no existing active (pending|confirmed) booking on the room (409)
 * On success: booking `pending` (fee unpaid) + room status → `booking`, atomically.
 */
export async function createBooking(
  tenantId: string,
  userId: string,
  input: CreateBookingInput,
) {
  const room = await prisma.room.findFirst({ where: { id: input.roomId } });
  if (!room) throw Errors.notFound('Room not found');
  if (room.status !== 'empty') {
    throw Errors.conflict(
      `Room is not available for booking (current status: ${room.status}); only an 'empty' room can be booked`,
    );
  }

  const existingActive = await prisma.booking.findFirst({
    where: { roomId: input.roomId, status: { in: ACTIVE_BOOKING_STATUSES } },
  });
  if (existingActive) {
    throw Errors.conflict('This room already has an active booking');
  }

  const feeDueAt = input.feeDueAt
    ? new Date(input.feeDueAt)
    : new Date(Date.now() + DEFAULT_FEE_WINDOW_MS);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          tenantId,
          propertyId: room.propertyId,
          roomId: input.roomId,
          prospectName: input.prospectName,
          prospectPhone: input.prospectPhone,
          prospectEmail: input.prospectEmail,
          plannedCheckInDate: new Date(input.plannedCheckInDate),
          bookingFeeAmount: input.bookingFeeAmount,
          bookingFeeMethod: input.bookingFeeMethod,
          feeStatus: 'unpaid',
          feeDueAt,
          status: 'pending',
          notes: input.notes,
          recordedByUserId: userId,
        },
      });
      // Reserve the room.
      await tx.room.update({ where: { id: input.roomId }, data: { status: 'booking' } });
      return booking;
    });

    // Best-effort IN-APP booking_new notification (PRD §6.18) → owner/manager/admin. Never throws.
    await notify({
      tenantId,
      type: 'booking_new',
      title: 'Booking baru',
      body: `Booking baru dari ${created.prospectName} untuk kamar ${room.roomNumber}.`,
      link: '/bookings',
      entityType: 'booking',
      entityId: created.id,
    });

    return serializeBooking(created);
  } catch (e) {
    // Partial unique index race → another active booking won; treat as conflict.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw Errors.conflict('This room already has an active booking');
    }
    throw e;
  }
}

/**
 * Confirm a booking (manual fee confirmation — no payment gateway). Only from `pending`.
 * Sets feeStatus=paid, status=confirmed. Room stays `booking`.
 */
export async function confirmBooking(id: string) {
  const booking = await getBooking(id);
  if (booking.status !== 'pending') {
    throw Errors.conflict(
      `Only a pending booking can be confirmed (current status: ${booking.status})`,
    );
  }
  const updated = await prisma.booking.update({
    where: { id },
    data: { status: 'confirmed', feeStatus: 'paid' },
  });
  return serializeBooking(updated);
}

/**
 * Convert a booking into a Resident + Occupancy (REUSES the residents creation pattern).
 * Only from `pending|confirmed`. Defaults: monthlyRent = room.basePrice, checkInDate =
 * plannedCheckInDate. Sets room → `occupied`, booking → `converted` + convertedResidentId.
 * Optionally generates the first (pro-rata) invoice via the shared invoice service.
 * All resident/occupancy/room/booking writes happen in one transaction.
 */
export async function convertBooking(
  tenantId: string,
  id: string,
  input: ConvertBookingInput,
) {
  const booking = await getBooking(id);
  if (!['pending', 'confirmed'].includes(booking.status)) {
    throw Errors.conflict(
      `Only a pending or confirmed booking can be converted (current status: ${booking.status})`,
    );
  }

  // A room-less PUBLIC inquiry (roomId null) cannot be converted directly — staff must first assign
  // a room (cancel + re-create an internal booking on a specific room, or edit). Guard with a 409.
  if (!booking.roomId) {
    throw Errors.conflict('This booking has no room assigned; assign a room before converting');
  }
  const roomId = booking.roomId; // narrowed (string) — used inside the transaction closure below
  const room = await prisma.room.findFirst({ where: { id: roomId } });
  if (!room) throw Errors.notFound('Room not found');
  // Guard: the room must not already be occupied by someone else (defensive — the booking held it).
  if (room.status === 'occupied') {
    throw Errors.conflict('Room is already occupied');
  }

  const monthlyRent = input.monthlyRent ?? Number(room.basePrice);
  const checkInDateStr = input.checkInDate ?? dateOnly(booking.plannedCheckInDate)!;
  const checkInDate = new Date(checkInDateStr);

  // Encrypt PII (A6) — same handling as residents.service.createResident.
  const nikEnc = encryptNullable(input.nik ?? null);
  const nikLast4 = input.nik ? input.nik.slice(-4) : null;
  const ktpPhotoKeyEnc = encryptNullable(input.ktpKey ?? null);

  const residentId = await prisma.$transaction(async (tx) => {
    const resident = await tx.resident.create({
      data: {
        tenantId,
        propertyId: booking.propertyId,
        roomId,
        fullName: booking.prospectName,
        nikEnc,
        nikLast4,
        phone: booking.prospectPhone,
        email: input.email ?? booking.prospectEmail,
        occupation: input.occupation,
        gender: input.gender,
        ktpPhotoKeyEnc,
        selfieKey: input.selfieKey,
        emergencyName: input.emergencyContact?.name,
        emergencyPhone: input.emergencyContact?.phone,
        emergencyRelation: input.emergencyContact?.relation,
        monthlyRent,
        checkInDate,
        contractEndDate: input.contractEndDate ? new Date(input.contractEndDate) : null,
        internalNotes: input.internalNotes,
        status: 'active',
      },
    });

    await tx.occupancy.create({
      data: {
        tenantId,
        residentId: resident.id,
        propertyId: booking.propertyId,
        roomId,
        monthlyRent,
        startDate: checkInDate,
        status: 'active',
      },
    });

    await tx.room.update({ where: { id: roomId }, data: { status: 'occupied' } });

    await tx.booking.update({
      where: { id },
      data: { status: 'converted', convertedResidentId: resident.id },
    });

    return resident.id;
  });

  // Optional first (pro-rata) invoice — uses the SAME shared generateInvoices service that backs
  // POST /invoices/generate and the daily cron (no duplicated billing logic). Done after the
  // transaction so a billing edge case never rolls back the conversion itself.
  let firstInvoice: { created: number; skipped: number } | undefined;
  if (input.generateFirstInvoice) {
    const result = await generateInvoices(tenantId, {
      propertyId: booking.propertyId,
      periodMonth: checkInDate.getUTCMonth() + 1,
      periodYear: checkInDate.getUTCFullYear(),
      residentIds: [residentId],
    });
    firstInvoice = { created: result.created, skipped: result.skipped };
  }

  const updated = await getBooking(id);
  return { booking: serializeBooking(updated), residentId, firstInvoice };
}

/**
 * Cancel a booking. From `pending|confirmed`. Sets status=cancelled; if the room is still
 * `booking`, release it back to `empty`. (Already-converted/cancelled/expired → 409.)
 */
export async function cancelBooking(id: string, input: CancelBookingInput) {
  const booking = await getBooking(id);
  if (!['pending', 'confirmed'].includes(booking.status)) {
    throw Errors.conflict(
      `Only a pending or confirmed booking can be cancelled (current status: ${booking.status})`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const b = await tx.booking.update({
      where: { id },
      data: {
        status: 'cancelled',
        notes: input.reason
          ? `${booking.notes ?? ''}\n[cancelled] ${input.reason}`.trim()
          : booking.notes,
      },
    });
    // Release the room only if it is still held by this booking (room-less public lead has none).
    if (booking.roomId) {
      const room = await tx.room.findFirst({ where: { id: booking.roomId } });
      if (room && room.status === 'booking') {
        await tx.room.update({ where: { id: booking.roomId }, data: { status: 'empty' } });
      }
    }
    return b;
  });

  return serializeBooking(updated);
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// PUBLIC BOOKING — now IMPLEMENTED (PRD §6.2, §6.13). See `src/modules/public/`.
//
// The UNAUTHENTICATED public self-service link (POST /public/properties/:slug/bookings) lives in the
// `public` module, mounted OUTSIDE the protected router. It resolves the tenant from
// `Property.publicSlug` (+ `publicEnabled`), runs inside `runWithTenant`, and reuses the SAME create
// invariants as `createBooking` above (room must be `empty` → status `booking`, pending+unpaid,
// anti-double-booking via the partial unique index, auto-release by the bookingReleaser job). The
// only differences: `recordedByUserId` is null, `source='public'`, `feeDueAt` defaults to +48h, the
// fee amount is 0 (settlement is manual/confirmBooking), and a room-less inquiry lead is allowed.
// ──────────────────────────────────────────────────────────────────────────────────────────
