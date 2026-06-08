/**
 * Deposit Management module tests (PRD §6.6). Proves:
 *  (a) record a deposit → status `held`, amounts initialized;
 *  (b) refund with a deduction → `partially_refunded` with correct refunded/deduction amounts;
 *  (c) full refund (refundedAmount === amount) → `refunded`;
 *  (d) forfeit (refundedAmount === 0) → `forfeited`;
 *  (e) refund where refundedAmount + deductionAmount > amount → 422 (VALIDATION_ERROR);
 *  (f) outstanding report lists only non-refunded (status=held) deposits;
 *  (g) Basic-plan tenant → 403 (FORBIDDEN) on create.
 *
 * Calls the deposit service inside a tenant-scoped AsyncLocalStorage context (the same guard
 * the API uses). Run: node --require ts-node/register --test tests/deposits.test.ts
 */
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as deposits from '../src/modules/deposits/deposits.service';
import { AppError } from '../src/utils/errors';

const raw = new PrismaClient();

let proTenantId: string;
let proPropertyId: string;
let resA: string; // partial-refund resident
let resB: string; // full-refund resident
let resC: string; // forfeit resident
let resD: string; // 422 resident

let basicTenantId: string;
let basicResidentId: string;

const userId = '00000000-0000-0000-0000-0000000000bb';

function asPro<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: proTenantId, userId }, fn);
}
function asBasic<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: basicTenantId, userId }, fn);
}

async function makeResident(tenantId: string, propertyId: string, roomId: string, name: string) {
  const r = await raw.resident.create({
    data: {
      tenantId,
      propertyId,
      roomId,
      fullName: name,
      nikEnc: 'x.x.x',
      nikLast4: '0000',
      phone: '081200000000',
      gender: 'male',
      monthlyRent: 1000000,
      checkInDate: new Date(Date.UTC(2026, 0, 1)),
      status: 'active',
    },
  });
  return r.id;
}

before(async () => {
  const stamp = Date.now();
  const proTenant = await raw.tenant.create({
    data: {
      name: `DepPro ${stamp}`,
      slug: `dep-pro-${stamp}`,
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
  proTenantId = proTenant.id;
  const prop = await raw.property.create({
    data: {
      tenantId: proTenantId,
      name: 'Deposit Kos',
      type: 'campur',
      address: 'Jl Deposit 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      isActive: true,
    },
  });
  proPropertyId = prop.id;
  const room = await raw.room.create({
    data: { tenantId: proTenantId, propertyId: proPropertyId, roomNumber: 'D1', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });
  resA = await makeResident(proTenantId, proPropertyId, room.id, 'Dep A');
  resB = await makeResident(proTenantId, proPropertyId, room.id, 'Dep B');
  resC = await makeResident(proTenantId, proPropertyId, room.id, 'Dep C');
  resD = await makeResident(proTenantId, proPropertyId, room.id, 'Dep D');

  const basicTenant = await raw.tenant.create({
    data: {
      name: `DepBasic ${stamp}`,
      slug: `dep-basic-${stamp}`,
      subscriptionPlan: 'basic',
      subscriptionStatus: 'active',
      maxProperties: 1,
      maxRooms: 20,
      maxUsers: 2,
      counter: { create: {} },
    },
  });
  basicTenantId = basicTenant.id;
  const bp = await raw.property.create({
    data: {
      tenantId: basicTenantId,
      name: 'Basic Kos',
      type: 'campur',
      address: 'Jl Basic 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      isActive: true,
    },
  });
  const br = await raw.room.create({
    data: { tenantId: basicTenantId, propertyId: bp.id, roomNumber: 'B1', roomType: 'standard', basePrice: 800000, status: 'occupied' },
  });
  basicResidentId = await makeResident(basicTenantId, bp.id, br.id, 'Basic Res');
});

after(async () => {
  if (proTenantId) await raw.tenant.delete({ where: { id: proTenantId } }).catch(() => {});
  if (basicTenantId) await raw.tenant.delete({ where: { id: basicTenantId } }).catch(() => {});
  await raw.$disconnect();
});

test('(a) record a deposit → status held, amounts initialized', async () => {
  const d = await asPro(() =>
    deposits.createDeposit(proTenantId, resA, userId, {
      amount: 1000000,
      method: 'transfer',
      receivedDate: '2026-01-05',
    }),
  );
  assert.equal(d.status, 'held');
  assert.equal(d.amount, 1000000);
  assert.equal(d.refundedAmount, 0);
  assert.equal(d.deductionAmount, 0);
  assert.equal(d.method, 'transfer');
});

test('(b) refund with deduction → partially_refunded with correct amounts', async () => {
  const d = await asPro(() =>
    deposits.createDeposit(proTenantId, resA, userId, { amount: 1000000, method: 'cash', receivedDate: '2026-01-05' }),
  );
  const refunded = await asPro(() =>
    deposits.refundDeposit(proTenantId, d.id, {
      refundedAmount: 700000,
      deductionAmount: 300000,
      deductionNotes: 'Pintu lemari rusak (lihat berita acara check-out)',
      refundedDate: '2026-06-01',
    }),
  );
  assert.equal(refunded.status, 'partially_refunded');
  assert.equal(refunded.refundedAmount, 700000);
  assert.equal(refunded.deductionAmount, 300000);
  assert.equal(refunded.refundedDate, '2026-06-01');
});

test('(c) full refund (refunded === amount) → refunded', async () => {
  const d = await asPro(() =>
    deposits.createDeposit(proTenantId, resB, userId, { amount: 500000, method: 'cash', receivedDate: '2026-01-05' }),
  );
  const r = await asPro(() =>
    deposits.refundDeposit(proTenantId, d.id, { refundedAmount: 500000, deductionAmount: 0, refundedDate: '2026-06-01' }),
  );
  assert.equal(r.status, 'refunded');
  assert.equal(r.refundedAmount, 500000);
});

test('(d) forfeit (refundedAmount === 0) → forfeited', async () => {
  const d = await asPro(() =>
    deposits.createDeposit(proTenantId, resC, userId, { amount: 500000, method: 'cash', receivedDate: '2026-01-05' }),
  );
  const r = await asPro(() =>
    deposits.refundDeposit(proTenantId, d.id, { refundedAmount: 0, deductionAmount: 500000, deductionNotes: 'Kabur tanpa bayar', refundedDate: '2026-06-01' }),
  );
  assert.equal(r.status, 'forfeited');
  assert.equal(r.refundedAmount, 0);
  assert.equal(r.deductionAmount, 500000);
});

test('(e) refundedAmount + deductionAmount > amount → 422', async () => {
  const d = await asPro(() =>
    deposits.createDeposit(proTenantId, resD, userId, { amount: 1000000, method: 'cash', receivedDate: '2026-01-05' }),
  );
  await assert.rejects(
    () =>
      asPro(() =>
        deposits.refundDeposit(proTenantId, d.id, { refundedAmount: 800000, deductionAmount: 300000, refundedDate: '2026-06-01' }),
      ),
    (e: unknown) => e instanceof AppError && e.httpStatus === 422 && e.code === 'VALIDATION_ERROR',
  );
});

test('(f) outstanding report lists only non-refunded (held) deposits', async () => {
  // Create one fresh held deposit on resB (whose previous deposit is fully refunded).
  await asPro(() =>
    deposits.createDeposit(proTenantId, resB, userId, { amount: 250000, method: 'qris', receivedDate: '2026-02-01' }),
  );
  const report = await asPro(() =>
    deposits.listReport({ status: 'held', page: 1, limit: 100, sort_order: 'desc' }, undefined),
  );
  assert.ok(report.rows.length > 0, 'report should contain held deposits');
  assert.ok(report.rows.every((r) => r.status === 'held'), 'every reported deposit must be held');
  assert.ok(report.totalAmount > 0, 'totalAmount summary should be > 0');
});

test('(g) Basic-plan tenant → 403 FORBIDDEN on deposit create', async () => {
  await assert.rejects(
    () =>
      asBasic(() =>
        deposits.createDeposit(basicTenantId, basicResidentId, userId, { amount: 100000, method: 'cash', receivedDate: '2026-01-05' }),
      ),
    (e: unknown) => e instanceof AppError && e.httpStatus === 403 && e.code === 'FORBIDDEN',
  );
});
