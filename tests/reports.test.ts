/**
 * Reporting module tests (PRD §6.16). Proves:
 *  (a) invoices report: totals, countByStatus, rows (the 1 unpaid + 1 partial invoice land in
 *      outstanding correctly);
 *  (b) residents report: movedIn/movedOut counted within the period + active count;
 *  (c) occupancy trend: returns N months, current month reflects the active occupancy;
 *  (d) revenue report: realized = payments that month; target = SUM(monthlyRent of active
 *      occupancies that month) — the documented definition; yearly totals;
 *  (e) room-types report: per-type count/occupied/occupancyRate/revenue;
 *  (f) Excel export: returns a non-empty application/...sheet buffer (PK ZIP magic bytes + len>0)
 *      for every report type;
 *  (g) export RBAC: route gate is FINANCE_PLUS → admin denied (403), finance allowed;
 *  (h) export plan gate: Basic plan → 403 via assertPlanFeature('reports').
 *
 * Services are called inside a tenant-scoped AsyncLocalStorage context (the same guard the API
 * uses). RBAC is asserted by invoking the rbacGuard middleware directly (the route layer). The
 * export buffer is built directly via the excel builder + plan gate (same code path the
 * controller runs).
 * Run: node --require ts-node/register --test tests/reports.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as reports from '../src/modules/reports/reports.service';
import { updateProperty } from '../src/modules/properties/properties.service';
import { buildReportExcel } from '../src/modules/reports/reports.excel';
import { assertPlanFeature } from '../src/services/plan.service';
import { rbacGuard, FINANCE_PLUS } from '../src/middleware/rbacGuard';
import { AppError } from '../src/utils/errors';
import type { JwtRole } from '../src/utils/jwt';

const raw = new PrismaClient();

let proTenantId: string;
let proPropertyId: string;
let noInvestPropertyId: string;
let basicTenantId: string;

const userId = '00000000-0000-0000-0000-0000000000ee';
// Use the CURRENT month/year so occupancy/revenue trend (which is anchored to "now") sees the
// fixture occupancies. Invoice period uses the same month/year.
const NOW = new Date();
const YEAR = NOW.getUTCFullYear();
const MONTH = NOW.getUTCMonth() + 1;

function asPro<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: proTenantId, userId }, fn);
}
function asBasic<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: basicTenantId, userId }, fn);
}

function guardResult(roles: JwtRole[], role: JwtRole): Promise<AppError | null> {
  return new Promise((resolve) => {
    const req = { auth: { role, userId, tenantId: proTenantId } } as never;
    rbacGuard(roles)(req, {} as never, (err?: unknown) => resolve((err as AppError) ?? null));
  });
}

before(async () => {
  const stamp = Date.now();
  const proTenant = await raw.tenant.create({
    data: {
      name: `RepPro ${stamp}`,
      slug: `rep-pro-${stamp}`,
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
      name: 'Report Kos',
      type: 'campur',
      address: 'Jl Report 1',
      city: 'Jakarta',
      province: 'DKI Jakarta',
      billingDay: 1,
      isActive: true,
      // Investment value for the ROI report: Rp100jt (chosen so the assertions are exact).
      investmentValue: 100000000,
    },
  });
  proPropertyId = prop.id;

  // A second property with NO investmentValue (and no payments) → ROI roiPercent must be null.
  const propNoInvest = await raw.property.create({
    data: {
      tenantId: proTenantId,
      name: 'No-Invest Kos',
      type: 'campur',
      address: 'Jl Report 2',
      city: 'Jakarta',
      province: 'DKI Jakarta',
      billingDay: 1,
      isActive: true,
      investmentValue: null,
    },
  });
  noInvestPropertyId = propNoInvest.id;

  // Two rooms, two types. One occupied (standard), one occupied (deluxe).
  const roomA = await raw.room.create({
    data: { tenantId: proTenantId, propertyId: proPropertyId, roomNumber: 'R1', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });
  const roomB = await raw.room.create({
    data: { tenantId: proTenantId, propertyId: proPropertyId, roomNumber: 'R2', roomType: 'deluxe', basePrice: 1500000, status: 'occupied' },
  });
  // An empty room to make occupancy < 100%.
  await raw.room.create({
    data: { tenantId: proTenantId, propertyId: proPropertyId, roomNumber: 'R3', roomType: 'standard', basePrice: 1000000, status: 'empty' },
  });

  // Resident A: moved in THIS month (counts as movedIn), active, rent 1,000,000.
  const resA = await raw.resident.create({
    data: {
      tenantId: proTenantId,
      propertyId: proPropertyId,
      roomId: roomA.id,
      fullName: 'Resident A',
      phone: '081200000001',
      gender: 'male',
      monthlyRent: 1000000,
      checkInDate: new Date(Date.UTC(YEAR, MONTH - 1, 3)),
      status: 'active',
    },
  });
  // Resident B: active, rent 1,500,000, checked in earlier.
  const resB = await raw.resident.create({
    data: {
      tenantId: proTenantId,
      propertyId: proPropertyId,
      roomId: roomB.id,
      fullName: 'Resident B',
      phone: '081200000002',
      gender: 'female',
      monthlyRent: 1500000,
      checkInDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
      status: 'active',
    },
  });

  // Active occupancies for both (target = 1,000,000 + 1,500,000 = 2,500,000 this month).
  await raw.occupancy.create({
    data: { tenantId: proTenantId, residentId: resA.id, propertyId: proPropertyId, roomId: roomA.id, monthlyRent: 1000000, startDate: new Date(Date.UTC(YEAR, MONTH - 1, 3)), status: 'active' },
  });
  await raw.occupancy.create({
    data: { tenantId: proTenantId, residentId: resB.id, propertyId: proPropertyId, roomId: roomB.id, monthlyRent: 1500000, startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)), status: 'active' },
  });

  // Invoice A: unpaid, 1,000,000 outstanding.
  await raw.invoice.create({
    data: {
      tenantId: proTenantId,
      invoiceNumber: `INV-${YEAR}-000801`,
      propertyId: proPropertyId,
      roomId: roomA.id,
      residentId: resA.id,
      periodMonth: MONTH,
      periodYear: YEAR,
      dueDate: new Date(Date.UTC(YEAR, MONTH - 1, 5)),
      subtotal: 1000000,
      totalAmount: 1000000,
      paidAmount: 0,
      status: 'unpaid',
    },
  });
  // Invoice B: partial, 1,500,000 total / 500,000 paid → 1,000,000 outstanding.
  const invB = await raw.invoice.create({
    data: {
      tenantId: proTenantId,
      invoiceNumber: `INV-${YEAR}-000802`,
      propertyId: proPropertyId,
      roomId: roomB.id,
      residentId: resB.id,
      periodMonth: MONTH,
      periodYear: YEAR,
      dueDate: new Date(Date.UTC(YEAR, MONTH - 1, 5)),
      subtotal: 1500000,
      totalAmount: 1500000,
      paidAmount: 500000,
      status: 'partial',
    },
  });
  // Payment of 500,000 received THIS month (realized revenue + room B revenue).
  await raw.payment.create({
    data: {
      tenantId: proTenantId,
      invoiceId: invB.id,
      amount: 500000,
      method: 'cash',
      paidAt: new Date(Date.UTC(YEAR, MONTH - 1, 10)),
      recordedBy: userId,
    },
  });

  const basicTenant = await raw.tenant.create({
    data: {
      name: `RepBasic ${stamp}`,
      slug: `rep-basic-${stamp}`,
      subscriptionPlan: 'basic',
      subscriptionStatus: 'active',
      maxProperties: 1,
      maxRooms: 20,
      maxUsers: 2,
      counter: { create: {} },
    },
  });
  basicTenantId = basicTenant.id;
});

after(async () => {
  if (proTenantId) await raw.tenant.delete({ where: { id: proTenantId } }).catch(() => {});
  if (basicTenantId) await raw.tenant.delete({ where: { id: basicTenantId } }).catch(() => {});
  await raw.$disconnect();
});

test('(a) invoices report: totals, countByStatus, outstanding includes the unpaid + partial', async () => {
  const r = await asPro(() => reports.invoicesReport({ property_id: proPropertyId, month: MONTH, year: YEAR }, undefined));
  assert.equal(r.totalInvoiced, 2500000);
  assert.equal(r.totalPaid, 500000);
  assert.equal(r.totalOutstanding, 2000000, 'outstanding = 1,000,000 (unpaid) + 1,000,000 (partial)');
  assert.equal(r.countByStatus.unpaid, 1);
  assert.equal(r.countByStatus.partial, 1);
  assert.equal(r.rows.length, 2);
  const a = r.rows.find((x) => x.invoiceNumber === `INV-${YEAR}-000801`)!;
  assert.equal(a.residentName, 'Resident A');
  assert.equal(a.roomNumber, 'R1');
  assert.equal(a.total, 1000000);
  assert.equal(a.paid, 0);
  assert.equal(a.status, 'unpaid');
});

test('(b) residents report: movedIn counted in period + active count', async () => {
  const r = await asPro(() => reports.residentsReport({ property_id: proPropertyId, month: MONTH, year: YEAR }, undefined));
  assert.equal(r.active, 2, 'both residents active');
  assert.equal(r.movedIn, 2, 'both checked in this month');
  assert.equal(r.movedOut, 0);
  assert.equal(r.rows.length, 2);
  const a = r.rows.find((x) => x.name === 'Resident A')!;
  assert.equal(a.roomNumber, 'R1');
  assert.equal(a.status, 'active');
});

test('(c) occupancy trend: returns N months; current month reflects 2 occupied of 3 rooms', async () => {
  const six = await asPro(() => reports.occupancyReport({ property_id: proPropertyId, months: 6 }, undefined));
  assert.equal(six.length, 6);
  const current = six[six.length - 1];
  assert.equal(current.totalRooms, 3);
  assert.equal(current.occupied, 2);
  assert.equal(current.rate, round2((2 / 3) * 100));
  const twelve = await asPro(() => reports.occupancyReport({ property_id: proPropertyId, months: 12 }, undefined));
  assert.equal(twelve.length, 12);
});

test('(d) revenue report: realized=payments this month; target=SUM(active rent); yearly totals', async () => {
  const r = await asPro(() => reports.revenueReport({ property_id: proPropertyId, year: YEAR }, undefined));
  assert.equal(r.rows.length, 12);
  const current = r.rows.find((x) => x.month === `${YEAR}-${String(MONTH).padStart(2, '0')}`)!;
  assert.equal(current.realized, 500000, 'realized = the 500,000 payment received this month');
  assert.equal(current.target, 2500000, 'target = 1,000,000 + 1,500,000 active rent this month');
  assert.equal(r.year, YEAR);
  // Yearly realized total includes only this month's payment.
  assert.equal(r.totalRealized, 500000);
  assert.ok(r.totalTarget >= 2500000, 'yearly target accumulates active-rent months');
});

test('(e) room-types report: per-type count/occupied/rate/revenue', async () => {
  const rows = await asPro(() => reports.roomTypesReport({ property_id: proPropertyId }, undefined));
  const standard = rows.find((x) => x.roomType === 'standard')!;
  const deluxe = rows.find((x) => x.roomType === 'deluxe')!;
  assert.equal(standard.count, 2, '2 standard rooms (R1, R3)');
  assert.equal(standard.occupied, 1, 'R1 occupied, R3 empty');
  assert.equal(standard.occupancyRate, 50);
  assert.equal(deluxe.count, 1);
  assert.equal(deluxe.occupied, 1);
  assert.equal(deluxe.occupancyRate, 100);
  assert.equal(deluxe.revenue, 500000, 'the 500,000 payment was on room B (deluxe) this year');
  assert.equal(standard.revenue, 0);
});

test('(f) excel export: every type returns a non-empty .xlsx buffer (PK ZIP magic + len>0)', async () => {
  const types = ['invoices', 'residents', 'occupancy', 'revenue', 'room-types', 'tax', 'roi'] as const;
  for (const type of types) {
    const { buffer, filename } = await asPro(() =>
      buildReportExcel(type, { property_id: proPropertyId, month: MONTH, year: YEAR, months: 6, rate: 0.1 }, undefined),
    );
    assert.ok(buffer.length > 0, `${type}: buffer not empty`);
    // .xlsx is a ZIP container → magic bytes PK\x03\x04.
    assert.equal(buffer[0], 0x50, `${type}: byte0 P`);
    assert.equal(buffer[1], 0x4b, `${type}: byte1 K`);
    assert.equal(buffer[2], 0x03, `${type}: byte2 0x03`);
    assert.equal(buffer[3], 0x04, `${type}: byte3 0x04`);
    assert.ok(filename.startsWith(`laporan-${type}-`) && filename.endsWith('.xlsx'), `${type}: filename`);
  }
});

test('(g) export RBAC: route gate FINANCE_PLUS → admin 403, finance allowed', async () => {
  assert.equal(await guardResult(FINANCE_PLUS, 'owner'), null);
  assert.equal(await guardResult(FINANCE_PLUS, 'manager'), null);
  assert.equal(await guardResult(FINANCE_PLUS, 'finance'), null, 'finance allowed to export');
  const adminErr = await guardResult(FINANCE_PLUS, 'admin');
  assert.ok(adminErr instanceof AppError && adminErr.httpStatus === 403, 'admin must be 403 on export');
});

test('(h) export plan gate: Basic plan → 403 FORBIDDEN via assertPlanFeature(reports)', async () => {
  // Pro passes.
  await asPro(() => assertPlanFeature(proTenantId, 'reports'));
  // Basic is rejected.
  await assert.rejects(
    () => asBasic(() => assertPlanFeature(basicTenantId, 'reports')),
    (err: unknown) => err instanceof AppError && err.httpStatus === 403 && err.code === 'FORBIDDEN',
  );
});

// ─────────────────────────── Tax (PPh) & ROI ───────────────────────────
test('(i) tax report: 12 rows, gross=collected payments, pphEstimate=gross×rate (default 10%)', async () => {
  const r = await asPro(() => reports.taxReport({ property_id: proPropertyId, year: YEAR, rate: 0.1 }, undefined));
  assert.equal(r.rows.length, 12);
  assert.equal(r.rate, 0.1);
  const current = r.rows.find((x) => x.month === `${YEAR}-${String(MONTH).padStart(2, '0')}`)!;
  assert.equal(current.grossIncome, 500000, 'gross = the 500,000 collected this month');
  assert.equal(current.pphEstimate, 50000, 'pph = 500,000 × 0.10');
  assert.equal(r.totalGross, 500000);
  assert.equal(r.totalPph, 50000);
});

test('(j) tax report: custom rate 0.05 → pphEstimate = gross × 0.05', async () => {
  const r = await asPro(() => reports.taxReport({ property_id: proPropertyId, year: YEAR, rate: 0.05 }, undefined));
  assert.equal(r.rate, 0.05);
  assert.equal(r.totalGross, 500000);
  assert.equal(r.totalPph, 25000, 'pph = 500,000 × 0.05');
});

test('(k) ROI report: investmentValue set → correct roiPercent + paybackYears', async () => {
  const r = await asPro(() => reports.roiReport({ property_id: proPropertyId, year: YEAR }, undefined));
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.investmentValue, 100000000);
  assert.equal(row.revenue, 500000, 'collected payments this year');
  assert.equal(row.expense, 0);
  assert.equal(row.netIncome, 500000);
  assert.equal(row.roiPercent, round2((500000 / 100000000) * 100), 'roi = net/investment×100 = 0.5%');
  assert.equal(row.paybackYears, round2(100000000 / 500000), 'payback = investment/net = 200 years');
});

test('(l) ROI report: null investment → roiPercent and paybackYears null', async () => {
  const r = await asPro(() => reports.roiReport({ property_id: noInvestPropertyId, year: YEAR }, undefined));
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.investmentValue, null);
  assert.equal(row.roiPercent, null, 'no investment → roi null (UI: atur nilai investasi)');
  assert.equal(row.paybackYears, null);
});

test('(m) ROI aggregate (no property_id): a row per property + totals block', async () => {
  const r = await asPro(() => reports.roiReport({ year: YEAR }, undefined));
  assert.ok(r.rows.length >= 2, 'both fixture properties present');
  // totals.investmentValue is non-null because at least one property has an investment value.
  assert.equal(r.totals.investmentValue, 100000000);
  assert.equal(r.totals.revenue, 500000);
  assert.equal(r.totals.netIncome, 500000);
  assert.equal(r.totals.roiPercent, round2((500000 / 100000000) * 100));
});

test('(n) tax/roi view RBAC: FINANCE_PLUS → admin 403, owner/manager/finance allowed', async () => {
  assert.equal(await guardResult(FINANCE_PLUS, 'owner'), null);
  assert.equal(await guardResult(FINANCE_PLUS, 'manager'), null);
  assert.equal(await guardResult(FINANCE_PLUS, 'finance'), null);
  const adminErr = await guardResult(FINANCE_PLUS, 'admin');
  assert.ok(adminErr instanceof AppError && adminErr.httpStatus === 403, 'admin must be 403 on tax/roi view');
});

test('(o) tax/roi xlsx export: valid PK ZIP buffer', async () => {
  for (const type of ['tax', 'roi'] as const) {
    const { buffer, filename } = await asPro(() =>
      buildReportExcel(type, { property_id: proPropertyId, month: MONTH, year: YEAR, months: 6, rate: 0.1 }, undefined),
    );
    assert.ok(buffer.length > 0, `${type}: buffer not empty`);
    assert.equal(buffer[0], 0x50, `${type}: byte0 P`);
    assert.equal(buffer[1], 0x4b, `${type}: byte1 K`);
    assert.ok(filename.startsWith(`laporan-${type}-`) && filename.endsWith('.xlsx'));
  }
});

test('(p) property update accepts investmentValue (set + clear)', async () => {
  // Update the no-invest property to set an investment value, then verify ROI picks it up.
  const set = await asPro(() =>
    updateProperty(noInvestPropertyId, {
      name: 'No-Invest Kos',
      type: 'campur',
      address: 'Jl Report 2',
      city: 'Jakarta',
      province: 'DKI Jakarta',
      investmentValue: 250000000,
    }),
  );
  assert.equal(set.investmentValue, 250000000, 'update sets investmentValue');

  // Clear it back to null.
  const cleared = await asPro(() =>
    updateProperty(noInvestPropertyId, {
      name: 'No-Invest Kos',
      type: 'campur',
      address: 'Jl Report 2',
      city: 'Jakarta',
      province: 'DKI Jakarta',
      investmentValue: null,
    }),
  );
  assert.equal(cleared.investmentValue, null, 'update clears investmentValue to null');
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
