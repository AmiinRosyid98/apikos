/**
 * Booking Management module tests (PRD §6.13). Proves the state machine + room-status
 * integration + auto-release job + RBAC:
 *  (a) create booking → room becomes `booking`, booking `pending`, fee `unpaid`;
 *  (b) create on a non-empty room → 409 CONFLICT;
 *  (c) duplicate active booking on the same room → 409 CONFLICT;
 *  (d) confirm → `confirmed`, fee `paid`;
 *  (e) convert → creates Resident + Occupancy, room `occupied`, booking `converted`,
 *      convertedResidentId set;
 *  (f) cancel → booking `cancelled`, room back to `empty`;
 *  (g) invalid transition (convert an already-converted booking) → 409;
 *  (h) auto-release pure function: a pending+unpaid booking past feeDueAt → `expired` + room
 *      `empty`; a not-yet-due one is untouched;
 *  (i) RBAC: create Admin+ (finance → 403), confirm/cancel Manager+ (admin → 403),
 *      convert Admin+ (finance → 403).
 *
 * Services are called inside a tenant-scoped AsyncLocalStorage context (the same guard the API
 * uses). RBAC is asserted by invoking the rbacGuard middleware directly (the route layer).
 * Run: node --require ts-node/register --test tests/bookings.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as bookings from '../src/modules/bookings/bookings.service';
import { runBookingRelease, disconnectBookingReleaser } from '../src/jobs/bookingReleaser';
import { rbacGuard, ADMIN_PLUS, MANAGER_PLUS } from '../src/middleware/rbacGuard';
import { AppError } from '../src/utils/errors';
import type { JwtRole } from '../src/utils/jwt';

const raw = new PrismaClient();

let tenantId: string;
let propertyId: string;
let roomA: string; // create / confirm / convert flow
let roomB: string; // non-empty (occupied) → 409
let roomC: string; // duplicate active booking → 409
let roomD: string; // cancel → back to empty
let roomE: string; // auto-release (expired)
let roomF: string; // auto-release (not yet due — untouched)

const userId = '00000000-0000-0000-0000-0000000000b0';

function asTenant<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId, userId }, fn);
}

/** Invoke an rbacGuard for a role; resolves to the AppError passed to next(), or null. */
function guardResult(roles: JwtRole[], role: JwtRole): Promise<AppError | null> {
  return new Promise((resolve) => {
    const req = { auth: { role, userId, tenantId } } as never;
    rbacGuard(roles)(req, {} as never, (err?: unknown) => resolve((err as AppError) ?? null));
  });
}

async function makeRoom(number: string, status: 'empty' | 'occupied'): Promise<string> {
  const r = await raw.room.create({
    data: {
      tenantId,
      propertyId,
      roomNumber: number,
      roomType: 'standard',
      basePrice: 1000000,
      status,
    },
  });
  return r.id;
}

before(async () => {
  const stamp = Date.now();
  const tenant = await raw.tenant.create({
    data: {
      name: `BookPro ${stamp}`,
      slug: `book-pro-${stamp}`,
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
  tenantId = tenant.id;
  const prop = await raw.property.create({
    data: {
      tenantId,
      name: 'Booking Kos',
      type: 'campur',
      address: 'Jl Booking 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      isActive: true,
    },
  });
  propertyId = prop.id;
  roomA = await makeRoom('A', 'empty');
  roomB = await makeRoom('B', 'occupied');
  roomC = await makeRoom('C', 'empty');
  roomD = await makeRoom('D', 'empty');
  roomE = await makeRoom('E', 'empty');
  roomF = await makeRoom('F', 'empty');
});

after(async () => {
  if (tenantId) await raw.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await disconnectBookingReleaser();
  await raw.$disconnect();
});

test('(a) create booking → room becomes booking, status pending, fee unpaid', async () => {
  const b = await asTenant(() =>
    bookings.createBooking(tenantId, userId, {
      roomId: roomA,
      prospectName: 'Andi Prospect',
      prospectPhone: '081200000001',
      plannedCheckInDate: '2026-07-01',
      bookingFeeAmount: 150000,
      bookingFeeMethod: 'transfer',
    }),
  );
  assert.equal(b.status, 'pending');
  assert.equal(b.feeStatus, 'unpaid');
  assert.equal(b.bookingFeeAmount, 150000);
  assert.ok(b.feeDueAt, 'feeDueAt should default to now + 24h');
  const room = await raw.room.findUnique({ where: { id: roomA } });
  assert.equal(room?.status, 'booking');
});

test('(b) create on a non-empty room → 409 CONFLICT', async () => {
  await assert.rejects(
    () =>
      asTenant(() =>
        bookings.createBooking(tenantId, userId, {
          roomId: roomB, // occupied
          prospectName: 'X',
          prospectPhone: '081200000002',
          plannedCheckInDate: '2026-07-01',
          bookingFeeAmount: 0,
          bookingFeeMethod: 'cash',
        }),
      ),
    (e: unknown) => e instanceof AppError && e.httpStatus === 409 && e.code === 'CONFLICT',
  );
});

test('(c) duplicate active booking on the same room → 409 CONFLICT', async () => {
  await asTenant(() =>
    bookings.createBooking(tenantId, userId, {
      roomId: roomC,
      prospectName: 'First Booker',
      prospectPhone: '081200000003',
      plannedCheckInDate: '2026-07-01',
      bookingFeeAmount: 0,
      bookingFeeMethod: 'cash',
    }),
  );
  // Room C is now `booking`; a second create is blocked both by the empty-check AND, were the
  // room forced empty, by the active-booking guard. Assert the conflict.
  await assert.rejects(
    () =>
      asTenant(() =>
        bookings.createBooking(tenantId, userId, {
          roomId: roomC,
          prospectName: 'Second Booker',
          prospectPhone: '081200000004',
          plannedCheckInDate: '2026-07-01',
          bookingFeeAmount: 0,
          bookingFeeMethod: 'cash',
        }),
      ),
    (e: unknown) => e instanceof AppError && e.httpStatus === 409,
  );
});

test('(d) confirm → confirmed, fee paid', async () => {
  const list = await asTenant(() =>
    bookings.listBookings({ room_id: roomA, page: 1, limit: 10, sort_order: 'desc' }, undefined),
  );
  const bookingId = list.rows[0].id;
  const confirmed = await asTenant(() => bookings.confirmBooking(bookingId));
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.feeStatus, 'paid');
});

test('(e) convert → creates resident + occupancy, room occupied, booking converted', async () => {
  const list = await asTenant(() =>
    bookings.listBookings({ room_id: roomA, page: 1, limit: 10, sort_order: 'desc' }, undefined),
  );
  const bookingId = list.rows[0].id;
  const result = await asTenant(() =>
    bookings.convertBooking(tenantId, bookingId, { generateFirstInvoice: true }),
  );
  assert.equal(result.booking.status, 'converted');
  assert.ok(result.residentId, 'convertedResidentId should be set');
  assert.equal(result.booking.convertedResidentId, result.residentId);

  const resident = await raw.resident.findUnique({ where: { id: result.residentId } });
  assert.ok(resident, 'resident created');
  assert.equal(resident?.fullName, 'Andi Prospect');
  assert.equal(Number(resident?.monthlyRent), 1000000); // defaulted from room.basePrice

  const occupancy = await raw.occupancy.findFirst({
    where: { residentId: result.residentId, status: 'active' },
  });
  assert.ok(occupancy, 'active occupancy opened');

  const room = await raw.room.findUnique({ where: { id: roomA } });
  assert.equal(room?.status, 'occupied');

  // generateFirstInvoice → one invoice for the resident's check-in period.
  assert.equal(result.firstInvoice?.created, 1);
  const inv = await raw.invoice.findFirst({ where: { residentId: result.residentId } });
  assert.ok(inv, 'first invoice generated');
});

test('(f) cancel → booking cancelled, room back to empty', async () => {
  const created = await asTenant(() =>
    bookings.createBooking(tenantId, userId, {
      roomId: roomD,
      prospectName: 'Cancel Me',
      prospectPhone: '081200000005',
      plannedCheckInDate: '2026-07-01',
      bookingFeeAmount: 0,
      bookingFeeMethod: 'cash',
    }),
  );
  let room = await raw.room.findUnique({ where: { id: roomD } });
  assert.equal(room?.status, 'booking');

  const cancelled = await asTenant(() =>
    bookings.cancelBooking(created.id, { reason: 'Calon batal' }),
  );
  assert.equal(cancelled.status, 'cancelled');
  room = await raw.room.findUnique({ where: { id: roomD } });
  assert.equal(room?.status, 'empty');
});

test('(g) invalid transition: convert an already-converted booking → 409', async () => {
  const list = await asTenant(() =>
    bookings.listBookings({ room_id: roomA, page: 1, limit: 10, sort_order: 'desc' }, undefined),
  );
  const convertedId = list.rows.find((b) => b.status === 'converted')!.id;
  await assert.rejects(
    () => asTenant(() => bookings.convertBooking(tenantId, convertedId, { generateFirstInvoice: false })),
    (e: unknown) => e instanceof AppError && e.httpStatus === 409,
  );
});

test('(h) auto-release: overdue pending+unpaid → expired + room empty; not-yet-due untouched', async () => {
  const now = Date.now();
  // Overdue booking on room E: feeDueAt 1h in the past.
  const overdue = await asTenant(() =>
    bookings.createBooking(tenantId, userId, {
      roomId: roomE,
      prospectName: 'Overdue',
      prospectPhone: '081200000006',
      plannedCheckInDate: '2026-07-01',
      bookingFeeAmount: 100000,
      bookingFeeMethod: 'cash',
      feeDueAt: new Date(now - 60 * 60 * 1000).toISOString(),
    }),
  );
  // Not-yet-due booking on room F: feeDueAt 24h in the future.
  const future = await asTenant(() =>
    bookings.createBooking(tenantId, userId, {
      roomId: roomF,
      prospectName: 'Future',
      prospectPhone: '081200000007',
      plannedCheckInDate: '2026-07-01',
      bookingFeeAmount: 100000,
      bookingFeeMethod: 'cash',
      feeDueAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    }),
  );

  const summary = await runBookingRelease({ tenantId, source: 'test' });
  assert.equal(summary.totalReleased, 1, 'exactly one booking released');

  const overdueAfter = await raw.booking.findUnique({ where: { id: overdue.id } });
  assert.equal(overdueAfter?.status, 'expired');
  const roomEAfter = await raw.room.findUnique({ where: { id: roomE } });
  assert.equal(roomEAfter?.status, 'empty', 'overdue booking room released');

  const futureAfter = await raw.booking.findUnique({ where: { id: future.id } });
  assert.equal(futureAfter?.status, 'pending', 'not-yet-due booking untouched');
  const roomFAfter = await raw.room.findUnique({ where: { id: roomF } });
  assert.equal(roomFAfter?.status, 'booking', 'not-yet-due booking still holds its room');

  // Idempotency: a second run releases nothing.
  const second = await runBookingRelease({ tenantId, source: 'test' });
  assert.equal(second.totalReleased, 0, 're-run is a no-op');
});

test('(i) RBAC: create Admin+, confirm/cancel Manager+, convert Admin+', async () => {
  // create → Admin+ : admin allowed, finance denied
  assert.equal(await guardResult(ADMIN_PLUS, 'admin'), null);
  assert.equal((await guardResult(ADMIN_PLUS, 'finance'))?.httpStatus, 403);
  // convert → Admin+ : finance denied
  assert.equal((await guardResult(ADMIN_PLUS, 'finance'))?.httpStatus, 403);
  // confirm/cancel → Manager+ : manager allowed, admin denied
  assert.equal(await guardResult(MANAGER_PLUS, 'manager'), null);
  assert.equal((await guardResult(MANAGER_PLUS, 'admin'))?.httpStatus, 403);
  // owner always allowed everywhere
  assert.equal(await guardResult(ADMIN_PLUS, 'owner'), null);
  assert.equal(await guardResult(MANAGER_PLUS, 'owner'), null);
});
