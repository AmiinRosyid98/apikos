/**
 * Meter/Utility module tests (PRD §6.17 / US-04). Proves:
 *  (a) first reading uses previous=0 and computes usage/amount;
 *  (b) second reading auto-derives previous from the first and computes the delta;
 *  (c) currentReading < previous → 422 (VALIDATION_ERROR);
 *  (d) missing photoKey → 422 (Zod, validated at the route layer);
 *  (e) duplicate (room,type,period) → CONFLICT (409);
 *  (f) invoice generation for a room WITH an electricity reading includes the electricity
 *      line item and a correct total (rent + electricity);
 *  (g) Basic-plan tenant → 403 (FORBIDDEN) on meter create.
 *
 * Runs directly against the DB (no live HTTP server) by calling the meter + invoice services
 * inside a tenant-scoped AsyncLocalStorage context (the same guard the API uses). Run with:
 *   node --require ts-node/register --test tests/meters.test.ts   (npm run test:meters)
 * Creates + tears down its own isolated tenant fixtures.
 */
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import { createMeterReadingSchema } from '../src/modules/meters/meters.validators';
import * as meters from '../src/modules/meters/meters.service';
import { generateInvoices } from '../src/modules/invoices/invoices.service';
import { AppError } from '../src/utils/errors';

const raw = new PrismaClient();

// Pro-plan fixture (meter feature enabled).
let proTenantId: string;
let proPropertyId: string;
let proRoomId: string;
let proResidentId: string;
const ELEC_PRICE = 1500; // property.electricityPriceKwh

// Basic-plan fixture (meter feature denied).
let basicTenantId: string;
let basicRoomId: string;

const userId = '00000000-0000-0000-0000-0000000000aa';
const period = { periodMonth: 5, periodYear: 2026 };

function asPro<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: proTenantId, userId }, fn);
}
function asBasic<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: basicTenantId, userId }, fn);
}

before(async () => {
  const stamp = Date.now();

  const proTenant = await raw.tenant.create({
    data: {
      name: `MeterPro ${stamp}`,
      slug: `meter-pro-${stamp}`,
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
  proTenantId = proTenant.id;

  const proProperty = await raw.property.create({
    data: {
      tenantId: proTenantId,
      name: 'Meter Pro Kos',
      type: 'campur',
      address: 'Jl Meter 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      electricityPriceKwh: ELEC_PRICE,
      isActive: true,
    },
  });
  proPropertyId = proProperty.id;

  const room = await raw.room.create({
    data: { tenantId: proTenantId, propertyId: proPropertyId, roomNumber: 'M1', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });
  proRoomId = room.id;

  // Check-in on the 1st → full rent, no pro-rata. Rent = 1,000,000.
  const checkIn = new Date(Date.UTC(period.periodYear, period.periodMonth - 1, 1));
  const resident = await raw.resident.create({
    data: {
      tenantId: proTenantId,
      propertyId: proPropertyId,
      roomId: proRoomId,
      fullName: 'Meter Resident',
      nikEnc: 'x.x.x',
      nikLast4: '0000',
      phone: '081299990000',
      gender: 'male',
      monthlyRent: 1000000,
      checkInDate: checkIn,
      status: 'active',
    },
  });
  proResidentId = resident.id;

  // Basic-plan tenant fixture.
  const basicTenant = await raw.tenant.create({
    data: {
      name: `MeterBasic ${stamp}`,
      slug: `meter-basic-${stamp}`,
      subscriptionPlan: 'basic',
      subscriptionStatus: 'active',
      maxProperties: 1,
      maxRooms: 20,
      maxUsers: 2,
      counter: { create: {} },
    },
  });
  basicTenantId = basicTenant.id;
  const basicProperty = await raw.property.create({
    data: {
      tenantId: basicTenantId,
      name: 'Basic Kos',
      type: 'campur',
      address: 'Jl Basic 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      electricityPriceKwh: 1500,
      isActive: true,
    },
  });
  const basicRoom = await raw.room.create({
    data: { tenantId: basicTenantId, propertyId: basicProperty.id, roomNumber: 'B1', roomType: 'standard', basePrice: 800000, status: 'occupied' },
  });
  basicRoomId = basicRoom.id;
});

after(async () => {
  if (proTenantId) await raw.tenant.delete({ where: { id: proTenantId } }).catch(() => {});
  if (basicTenantId) await raw.tenant.delete({ where: { id: basicTenantId } }).catch(() => {});
  await raw.$disconnect();
});

// Helper: parse via the Zod schema then call the service (mirrors the validate() middleware).
function parseInput(body: unknown) {
  const r = createMeterReadingSchema.safeParse(body);
  return r;
}

test('(a) first reading: previous=0, usage and amount computed from price', async () => {
  const input = createMeterReadingSchema.parse({
    type: 'electricity',
    currentReading: 100,
    ...period,
    photoKey: 'meter/m1-may.jpg',
  });
  const reading = await asPro(() => meters.createReading(proTenantId, proRoomId, userId, input));

  assert.equal(reading.previousReading, 0, 'first reading previous should be 0');
  assert.equal(reading.usage, 100, 'usage = 100 - 0');
  assert.equal(reading.pricePerUnit, ELEC_PRICE, 'price defaulted to property.electricityPriceKwh');
  assert.equal(reading.amount, 100 * ELEC_PRICE, 'amount = usage * price');
});

test('(b) second reading: auto-derives previous from the first, computes delta', async () => {
  const input = createMeterReadingSchema.parse({
    type: 'electricity',
    currentReading: 175,
    periodMonth: 6,
    periodYear: 2026,
    photoKey: 'meter/m1-jun.jpg',
  });
  const reading = await asPro(() => meters.createReading(proTenantId, proRoomId, userId, input));

  assert.equal(reading.previousReading, 100, 'previous derived from May reading (100)');
  assert.equal(reading.usage, 75, 'usage = 175 - 100');
  assert.equal(reading.amount, 75 * ELEC_PRICE, 'amount = 75 * price');
});

test('(c) currentReading < previous → 422 VALIDATION_ERROR', async () => {
  const input = createMeterReadingSchema.parse({
    type: 'electricity',
    currentReading: 50, // < 175 (latest prior for Jul is Jun=175)
    periodMonth: 7,
    periodYear: 2026,
    photoKey: 'meter/m1-jul.jpg',
  });
  await assert.rejects(
    () => asPro(() => meters.createReading(proTenantId, proRoomId, userId, input)),
    (e: unknown) => e instanceof AppError && e.httpStatus === 422 && e.code === 'VALIDATION_ERROR',
  );
});

test('(d) missing photoKey → 422 (rejected by the create schema)', async () => {
  const r = parseInput({ type: 'electricity', currentReading: 200, ...period });
  assert.equal(r.success, false, 'schema must reject a body without photoKey');
  if (!r.success) {
    const hasPhotoErr = r.error.errors.some((e) => e.path.join('.') === 'photoKey');
    assert.ok(hasPhotoErr, 'error should point at photoKey');
  }
});

test('(e) duplicate (room,type,period) → 409 CONFLICT', async () => {
  const input = createMeterReadingSchema.parse({
    type: 'electricity',
    currentReading: 120,
    ...period, // May again → duplicate of test (a)
    photoKey: 'meter/m1-may-dup.jpg',
  });
  await assert.rejects(
    () => asPro(() => meters.createReading(proTenantId, proRoomId, userId, input)),
    (e: unknown) => e instanceof AppError && e.httpStatus === 409 && e.code === 'CONFLICT',
  );
});

test('(f) invoice generation includes the electricity line item with a correct total', async () => {
  // May has an electricity reading (test a): usage 100 × 1500 = 150,000. Rent = 1,000,000.
  const result = await asPro(() =>
    generateInvoices(proTenantId, { propertyId: proPropertyId, ...period }),
  );
  assert.equal(result.created, 1, 'one invoice generated for May');

  const invoice = await raw.invoice.findFirstOrThrow({
    where: { tenantId: proTenantId, residentId: proResidentId, periodMonth: period.periodMonth, periodYear: period.periodYear },
    include: { items: true },
  });

  const elec = invoice.items.find((i) => i.type === 'electricity');
  assert.ok(elec, 'invoice must contain an electricity line item');
  assert.equal(Number(elec.amount), 150000, 'electricity amount = 100 KWh × 1500');

  const rent = invoice.items.find((i) => i.type === 'rent');
  assert.ok(rent, 'invoice must still contain the rent item');
  assert.equal(Number(rent.amount), 1000000, 'rent = full monthly rent');

  assert.equal(Number(invoice.subtotal), 1150000, 'subtotal = rent + electricity');
  assert.equal(Number(invoice.totalAmount), 1150000, 'total = subtotal (no late fee)');
});

test('(g) Basic-plan tenant → 403 FORBIDDEN on meter create', async () => {
  const input = createMeterReadingSchema.parse({
    type: 'electricity',
    currentReading: 100,
    ...period,
    photoKey: 'meter/basic.jpg',
  });
  await assert.rejects(
    () => asBasic(() => meters.createReading(basicTenantId, basicRoomId, userId, input)),
    (e: unknown) => e instanceof AppError && e.httpStatus === 403 && e.code === 'FORBIDDEN',
  );
});
