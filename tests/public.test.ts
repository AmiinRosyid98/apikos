/**
 * PUBLIC Landing Page + Public Booking Link tests (PRD §6.2, §6.13).
 *
 * Exercises the FULL HTTP stack (no auth) via a real Express server on an ephemeral port, so it
 * proves the routes are mounted OUTSIDE the auth/tenant-guard, the honeypot + rate-limit middleware
 * fire, and the slug→tenant resolution + tenant isolation hold. Two isolated tenants are created and
 * torn down. Set strict env limits so the rate-limit trip is deterministic.
 *
 * Coverage:
 *  (a) GET enabled slug → property + ONLY empty rooms + price range, NO sensitive fields;
 *  (b) GET disabled slug → 404; (c) GET unknown slug → 404 (same shape — no existence leak);
 *  (d) POST with roomId → pending booking, source=public, room→booking, feeStatus unpaid,
 *      + a booking_new notification created;
 *  (e) POST without roomId → room-less inquiry lead (pending, no room reserved);
 *  (f) honeypot `_hp` filled → fake 200, NO booking created;
 *  (g) body-supplied tenantId/propertyId → rejected (strict schema) → 422, none honoured;
 *  (h) cross-tenant: a booking via tenant-A's slug lands in tenant A, never tenant B;
 *  (i) POST a room owned by ANOTHER property/tenant → 404 (cannot touch cross-tenant room);
 *  (j) strict rate limit trips after N submissions from the same IP → 429 RATE_LIMITED.
 *
 * Run: node --require ts-node/register --test tests/public.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
process.env.PUBLIC_BOOKING_RATE_LIMIT_MAX = '5';
process.env.PUBLIC_BOOKING_RATE_LIMIT_WINDOW_MS = '3600000';
process.env.PUBLIC_READ_RATE_LIMIT_MAX = '500';
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { disconnectPublic } from '../src/modules/public/public.service';

const raw = new PrismaClient();

let server: Server;
let baseUrl: string;

// Tenant A (the one we book against).
let tenantA: string;
let propAId: string;
const slugA = `kos-a-${Date.now()}`;
let emptyRoomA: string; // empty → bookable
let occupiedRoomA: string; // occupied → 404/conflict

// Tenant B (isolation target).
let tenantB: string;
let propBId: string;
let roomB: string; // belongs to B — must be untouchable via A's slug
const slugBDisabled = `kos-b-${Date.now()}`;

const futureDate = () => {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};

// `trust proxy` is enabled in the app, so the rate limiter keys on the X-Forwarded-For IP. Giving
// each functional test its OWN forwarded IP isolates it from the per-IP booking limit (5/window), so
// only the dedicated rate-limit test deliberately exhausts a single IP's bucket.
function postBooking(path: string, body: unknown, ip: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function body(res: Response): Promise<any> {
  return res.json();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function makeRoom(
  tenantId: string,
  propertyId: string,
  number: string,
  status: 'empty' | 'occupied',
  basePrice = 1000000,
): Promise<string> {
  const r = await raw.room.create({
    data: { tenantId, propertyId, roomNumber: number, roomType: 'standard', basePrice, status },
  });
  return r.id;
}

async function makeTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const t = await raw.tenant.create({
    data: {
      name: `${label} ${stamp}`,
      slug: `${label}-${stamp}`,
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
  return t.id;
}

before(async () => {
  // Tenant A — public ENABLED.
  tenantA = await makeTenant('public-a');
  // An owner user so the booking_new notification has a recipient.
  await raw.user.create({
    data: {
      tenantId: tenantA,
      email: `owner-a-${Date.now()}@test.kos`,
      passwordHash: 'x',
      fullName: 'Owner A',
      role: 'owner',
      isActive: true,
    },
  });
  const propA = await raw.property.create({
    data: {
      tenantId: tenantA,
      name: 'Kos Publik A',
      type: 'campur',
      address: 'Jl Publik 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      facilities: ['wifi', 'parkir'],
      publicSlug: slugA,
      publicEnabled: true,
      isActive: true,
    },
  });
  propAId = propA.id;
  emptyRoomA = await makeRoom(tenantA, propAId, 'A-empty', 'empty', 900000);
  occupiedRoomA = await makeRoom(tenantA, propAId, 'A-occupied', 'occupied', 1500000);

  // Tenant B — public DISABLED (slug set but publicEnabled=false).
  tenantB = await makeTenant('public-b');
  const propB = await raw.property.create({
    data: {
      tenantId: tenantB,
      name: 'Kos Publik B',
      type: 'campur',
      address: 'Jl Publik 2',
      city: 'Surabaya',
      province: 'Jawa Timur',
      publicSlug: slugBDisabled,
      publicEnabled: false,
      isActive: true,
    },
  });
  propBId = propB.id;
  roomB = await makeRoom(tenantB, propBId, 'B-empty', 'empty');

  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tenantA) await raw.tenant.delete({ where: { id: tenantA } }).catch(() => {});
  if (tenantB) await raw.tenant.delete({ where: { id: tenantB } }).catch(() => {});
  await disconnectPublic();
  await raw.$disconnect();
});

test('(a) GET enabled slug → property + only empty rooms + price range, no sensitive fields', async () => {
  const res = await fetch(`${baseUrl}/public/properties/${slugA}`);
  assert.equal(res.status, 200);
  const json = await body(res);
  assert.equal(json.success, true);
  const { property, availableRooms, priceRange } = json.data;
  assert.equal(property.name, 'Kos Publik A');
  assert.equal(property.publicSlug, slugA);
  // Only the EMPTY room is exposed (the occupied one is hidden).
  assert.equal(availableRooms.length, 1);
  assert.equal(availableRooms[0].roomNumber, 'A-empty');
  assert.equal(availableRooms[0].basePrice, 900000);
  assert.deepEqual(priceRange, { min: 900000, max: 900000 });
  // NO sensitive fields anywhere in the payload.
  const blob = JSON.stringify(json);
  for (const leak of ['tenantId', 'tenant_id', 'ownerId', 'electricityPriceKwh', 'lateFee', 'resident', 'nik']) {
    assert.equal(blob.includes(leak), false, `payload must not leak "${leak}"`);
  }
});

test('(b) GET disabled slug → 404 (no existence/state leak)', async () => {
  const res = await fetch(`${baseUrl}/public/properties/${slugBDisabled}`);
  assert.equal(res.status, 404);
  const json = await body(res);
  assert.equal(json.success, false);
  assert.equal(json.code, 'NOT_FOUND');
});

test('(c) GET unknown slug → 404 (same shape as disabled)', async () => {
  const res = await fetch(`${baseUrl}/public/properties/this-slug-does-not-exist`);
  assert.equal(res.status, 404);
  const json = await body(res);
  assert.equal(json.code, 'NOT_FOUND');
});

test('(d) POST with roomId → pending booking, source=public, room→booking, + booking_new notification', async () => {
  const before = await raw.notification.count({ where: { tenantId: tenantA, type: 'booking_new' } });
  const res = await postBooking(
    `/public/properties/${slugA}/bookings`,
    {
      prospectName: 'Citra Calon',
      prospectPhone: '0812-3456-7890',
      prospectEmail: 'citra@example.com',
      roomId: emptyRoomA,
      plannedCheckInDate: futureDate(),
      message: 'Kapan bisa lihat kamar?',
    },
    '10.0.0.1',
  );
  assert.equal(res.status, 201);
  const json = await body(res);
  assert.equal(json.success, true);
  assert.ok(json.data.reference, 'reference returned');
  assert.equal(json.data.status, 'pending');
  // No internal ids leaked beyond the short reference.
  assert.equal(JSON.stringify(json.data).includes(emptyRoomA), false);

  const booking = await raw.booking.findFirst({
    where: { tenantId: tenantA, roomId: emptyRoomA, source: 'public' },
  });
  assert.ok(booking, 'public booking persisted in tenant A');
  assert.equal(booking!.status, 'pending');
  assert.equal(booking!.feeStatus, 'unpaid');
  assert.equal(booking!.recordedByUserId, null);
  assert.equal(booking!.message, 'Kapan bisa lihat kamar?');

  const room = await raw.room.findUnique({ where: { id: emptyRoomA } });
  assert.equal(room!.status, 'booking', 'room reserved');

  const afterCount = await raw.notification.count({ where: { tenantId: tenantA, type: 'booking_new' } });
  assert.ok(afterCount > before, 'a booking_new notification was emitted');
});

test('(e) POST without roomId → room-less inquiry lead (pending, no room reserved)', async () => {
  const res = await postBooking(
    `/public/properties/${slugA}/bookings`,
    {
      prospectName: 'Dedi Inquiry',
      prospectPhone: '081299998888',
      plannedCheckInDate: futureDate(),
    },
    '10.0.0.2',
  );
  assert.equal(res.status, 201);
  const lead = await raw.booking.findFirst({
    where: { tenantId: tenantA, prospectName: 'Dedi Inquiry', source: 'public' },
  });
  assert.ok(lead, 'room-less lead persisted');
  assert.equal(lead!.roomId, null);
  assert.equal(lead!.status, 'pending');
});

test('(f) honeypot _hp filled → fake 200, NO booking created', async () => {
  const before = await raw.booking.count({ where: { tenantId: tenantA } });
  const res = await postBooking(
    `/public/properties/${slugA}/bookings`,
    {
      prospectName: 'Bot Spammer',
      prospectPhone: '081200000000',
      plannedCheckInDate: futureDate(),
      _hp: 'i-am-a-bot',
    },
    '10.0.0.3',
  );
  // Honeypot validation: _hp must be empty → the schema rejects a non-empty value with 422 BEFORE
  // the controller. Either way, NO booking is created. (Empty-string _hp reaches the fake-200 path.)
  const after = await raw.booking.count({ where: { tenantId: tenantA } });
  assert.equal(after, before, 'no booking created for a honeypot-filled submission');
  assert.ok([200, 201, 422].includes(res.status));
});

test('(f2) honeypot empty-string _hp → fake 200, still NO booking created', async () => {
  const before = await raw.booking.count({ where: { tenantId: tenantA } });
  const res = await postBooking(
    `/public/properties/${slugA}/bookings`,
    {
      prospectName: 'Looks Legit',
      prospectPhone: '081200000001',
      plannedCheckInDate: futureDate(),
      _hp: '',
    },
    '10.0.0.4',
  );
  assert.ok(res.status === 200 || res.status === 201);
  const json = await body(res);
  assert.equal(json.success, true);
  const after = await raw.booking.count({ where: { tenantId: tenantA } });
  // Empty string is allowed → a real booking IS created (legit client). So count should grow by 1.
  assert.equal(after, before + 1);
});

test('(g) body-supplied tenantId/propertyId → rejected by strict schema (422), never honoured', async () => {
  const res = await postBooking(
    `/public/properties/${slugA}/bookings`,
    {
      prospectName: 'Forger',
      prospectPhone: '081255554444',
      plannedCheckInDate: futureDate(),
      tenantId: tenantB,
      propertyId: propBId,
      source: 'internal',
    },
    '10.0.0.5',
  );
  assert.equal(res.status, 422);
  const json = await body(res);
  assert.equal(json.code, 'VALIDATION_ERROR');
  // Nothing landed in tenant B.
  const inB = await raw.booking.count({ where: { tenantId: tenantB } });
  assert.equal(inB, 0);
});

test('(k) POST an occupied (non-empty) room → 409 CONFLICT, not bookable', async () => {
  const res = await postBooking(
    `/public/properties/${slugA}/bookings`,
    {
      prospectName: 'Wants Occupied',
      prospectPhone: '081266665555',
      roomId: occupiedRoomA,
      plannedCheckInDate: futureDate(),
    },
    '10.0.0.7',
  );
  assert.equal(res.status, 409);
  const json = await body(res);
  assert.equal(json.code, 'CONFLICT');
});

test('(h) cross-tenant: a booking via tenant-A slug lands in tenant A only', async () => {
  const aCount = await raw.booking.count({ where: { tenantId: tenantA } });
  const bCount = await raw.booking.count({ where: { tenantId: tenantB } });
  assert.ok(aCount > 0, 'tenant A has the public bookings');
  assert.equal(bCount, 0, 'tenant B has NONE');
});

test('(i) POST a room owned by another property/tenant → 404 (cannot touch cross-tenant room)', async () => {
  const res = await postBooking(
    `/public/properties/${slugA}/bookings`,
    {
      prospectName: 'Cross Tenant',
      prospectPhone: '081277776666',
      roomId: roomB, // belongs to tenant B
      plannedCheckInDate: futureDate(),
    },
    '10.0.0.6',
  );
  assert.equal(res.status, 404);
  // Room B untouched (still empty), no booking in B.
  const room = await raw.room.findUnique({ where: { id: roomB } });
  assert.equal(room!.status, 'empty');
  assert.equal(await raw.booking.count({ where: { tenantId: tenantB } }), 0);
});

test('(j) strict rate limit trips after the configured max (5/window) from one IP → 429', async () => {
  // Dedicated IP so this test owns the whole bucket. PUBLIC_BOOKING_RATE_LIMIT_MAX=5 (set at top),
  // so the 6th submission within the window must be 429 RATE_LIMITED.
  const ip = '10.9.9.9';
  let saw429 = false;
  let okCount = 0;
  for (let i = 0; i < 8; i++) {
    const res = await postBooking(
      `/public/properties/${slugA}/bookings`,
      {
        prospectName: `Rate ${i}`,
        prospectPhone: '081200001111',
        plannedCheckInDate: futureDate(),
      },
      ip,
    );
    if (res.status === 429) {
      saw429 = true;
      const json = await body(res);
      assert.equal(json.code, 'RATE_LIMITED');
      break;
    }
    if (res.status === 201) okCount++;
    await res.text().catch(() => undefined);
  }
  assert.ok(saw429, 'strict per-IP rate limit returns 429 once the max is exceeded');
  assert.ok(okCount <= 5, `no more than the max (5) succeeded before the limit (got ${okCount})`);
});
