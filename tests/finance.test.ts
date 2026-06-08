/**
 * Finance / Keuangan module tests (PRD §6.12). Proves:
 *  (a) category create + list (defaults seeded);
 *  (b) expense create works for ALL roles;
 *  (c) delete-expense RBAC: admin/finance → 403, owner/manager → allowed (route guard);
 *  (d) cashflow returns 12 months; the month with a seeded payment + expense has the right
 *      income/expense/net;
 *  (e) summary math (income/expense/net/invoiced/collected/outstanding);
 *  (f) P&L: netProfit = revenue − totalExpense; admin → 403 (route guard); Basic plan → 403
 *      (reports feature gate);
 *  (g) reconciliation: invoiced vs collected diff.
 *
 * Services are called inside a tenant-scoped AsyncLocalStorage context (the same guard the API
 * uses). RBAC is asserted by invoking the rbacGuard middleware directly (the route layer).
 * Run: node --require ts-node/register --test tests/finance.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as finance from '../src/modules/finance/finance.service';
import { rbacGuard, MANAGER_PLUS, ADMIN_PLUS, FINANCE_PLUS } from '../src/middleware/rbacGuard';
import { AppError } from '../src/utils/errors';
import type { JwtRole } from '../src/utils/jwt';

const raw = new PrismaClient();

let proTenantId: string;
let proPropertyId: string;
let proRoomId: string;
let proResidentId: string;
let basicTenantId: string;

const userId = '00000000-0000-0000-0000-0000000000ff';
const YEAR = 2031; // isolated year so seeded/other data never interferes
const MONTH = 3;

function asPro<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: proTenantId, userId }, fn);
}
function asBasic<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: basicTenantId, userId }, fn);
}

/** Invoke an rbacGuard for a role; resolves to the AppError it passes to next(), or null. */
function guardResult(roles: JwtRole[], role: JwtRole): Promise<AppError | null> {
  return new Promise((resolve) => {
    const req = { auth: { role, userId, tenantId: proTenantId } } as never;
    rbacGuard(roles)(req, {} as never, (err?: unknown) =>
      resolve((err as AppError) ?? null),
    );
  });
}

before(async () => {
  const stamp = Date.now();
  const proTenant = await raw.tenant.create({
    data: {
      name: `FinPro ${stamp}`,
      slug: `fin-pro-${stamp}`,
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
      name: 'Finance Kos',
      type: 'campur',
      address: 'Jl Finance 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      isActive: true,
    },
  });
  proPropertyId = prop.id;
  const room = await raw.room.create({
    data: { tenantId: proTenantId, propertyId: proPropertyId, roomNumber: 'F1', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });
  proRoomId = room.id;
  const res = await raw.resident.create({
    data: {
      tenantId: proTenantId,
      propertyId: proPropertyId,
      roomId: proRoomId,
      fullName: 'Fin Resident',
      nikEnc: 'x.x.x',
      nikLast4: '0000',
      phone: '081200000000',
      gender: 'male',
      monthlyRent: 1000000,
      checkInDate: new Date(Date.UTC(YEAR, 0, 1)),
      status: 'active',
    },
  });
  proResidentId = res.id;

  // An invoice for the target period: total 1,000,000, partially paid 600,000.
  const invoice = await raw.invoice.create({
    data: {
      tenantId: proTenantId,
      invoiceNumber: `INV-${YEAR}-000999`,
      propertyId: proPropertyId,
      roomId: proRoomId,
      residentId: proResidentId,
      periodMonth: MONTH,
      periodYear: YEAR,
      dueDate: new Date(Date.UTC(YEAR, MONTH - 1, 5)),
      subtotal: 1000000,
      lateFee: 0,
      totalAmount: 1000000,
      paidAmount: 600000,
      status: 'partial',
    },
  });
  // A payment received in the target month (income source).
  await raw.payment.create({
    data: {
      tenantId: proTenantId,
      invoiceId: invoice.id,
      amount: 600000,
      method: 'cash',
      paidAt: new Date(Date.UTC(YEAR, MONTH - 1, 15)),
      recordedBy: userId,
    },
  });

  const basicTenant = await raw.tenant.create({
    data: {
      name: `FinBasic ${stamp}`,
      slug: `fin-basic-${stamp}`,
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

test('(a) categories: defaults seeded on first fetch + create a custom one', async () => {
  const { rows } = await asPro(() => finance.listCategories(proTenantId, { page: 1, limit: 100, sort_order: 'asc' }));
  const names = rows.map((c) => c.name);
  for (const def of ['Listrik PLN', 'Internet', 'Kebersihan', 'Maintenance', 'Gaji/Upah', 'Lainnya']) {
    assert.ok(names.includes(def), `default category "${def}" should be seeded`);
  }
  const custom = await asPro(() => finance.createCategory(proTenantId, { name: 'Pajak' }));
  assert.equal(custom.name, 'Pajak');
  assert.equal(custom.isDefault, false);
});

test('(b) expense create works for ALL roles (service-level; route gate is ALL)', async () => {
  const cats = await asPro(() => finance.listCategories(proTenantId, { page: 1, limit: 100, sort_order: 'asc' }));
  const listrik = cats.rows.find((c) => c.name === 'Listrik PLN')!;
  // Expense in the target month, 250,000.
  const created = await asPro(() =>
    finance.createExpense(proTenantId, userId, {
      categoryId: listrik.id,
      propertyId: proPropertyId,
      amount: 250000,
      date: `${YEAR}-0${MONTH}-10`,
    }),
  );
  assert.equal(created.amount, 250000);
  assert.equal(created.categoryName, 'Listrik PLN');
  assert.equal(created.propertyId, proPropertyId);
});

test('(c) delete-expense RBAC: admin/finance → 403, owner/manager → allowed', async () => {
  // Route gate for DELETE /finance/expenses/:id is MANAGER_PLUS (owner/manager only).
  assert.equal(await guardResult(MANAGER_PLUS, 'owner'), null);
  assert.equal(await guardResult(MANAGER_PLUS, 'manager'), null);
  const adminErr = await guardResult(MANAGER_PLUS, 'admin');
  assert.ok(adminErr instanceof AppError && adminErr.httpStatus === 403, 'admin must be 403');
  const financeErr = await guardResult(MANAGER_PLUS, 'finance');
  assert.ok(financeErr instanceof AppError && financeErr.httpStatus === 403, 'finance must be 403');

  // And the delete actually works at the service layer for an owner.
  const cats = await asPro(() => finance.listCategories(proTenantId, { page: 1, limit: 100, sort_order: 'asc' }));
  const cat = cats.rows.find((c) => c.name === 'Lainnya')!;
  const e = await asPro(() =>
    finance.createExpense(proTenantId, userId, { categoryId: cat.id, amount: 1000, date: `${YEAR}-01-01` }),
  );
  const del = await asPro(() => finance.deleteExpense(e.id));
  assert.equal(del.id, e.id);
});

test('(d) cashflow returns 12 months; target month has income from payment + expense', async () => {
  const months = await asPro(() => finance.cashflow({ year: YEAR }, undefined));
  assert.equal(months.length, 12);
  const target = months.find((m) => m.month === MONTH)!;
  assert.equal(target.income, 600000, 'income = the seeded payment');
  assert.equal(target.expense, 250000, 'expense = the seeded expense');
  assert.equal(target.net, 350000, 'net = income − expense');
  // A month with no activity is zeroed.
  const empty = months.find((m) => m.month === 1)!;
  assert.equal(empty.income, 0);
});

test('(e) summary math: income/expense/net/invoiced/collected/outstanding', async () => {
  const s = await asPro(() => finance.summary({ month: MONTH, year: YEAR }, undefined));
  assert.equal(s.income, 600000);
  assert.equal(s.expense, 250000);
  assert.equal(s.net, 350000);
  assert.equal(s.invoiced, 1000000);
  assert.equal(s.collected, 600000);
  assert.equal(s.outstanding, 400000);
});

test('(f) P&L: netProfit = revenue − totalExpense; admin → 403 route gate; Basic plan → 403', async () => {
  const pl = await asPro(() => finance.profitAndLoss(proTenantId, { year: YEAR }, undefined));
  assert.equal(pl.revenue, 600000, 'revenue = payments received in the year');
  assert.equal(pl.totalExpense, 250000, 'totalExpense = expenses in the year');
  assert.equal(pl.netProfit, 350000, 'netProfit = revenue − totalExpense');
  const listrikLine = pl.expensesByCategory.find((c) => c.category === 'Listrik PLN');
  assert.ok(listrikLine && listrikLine.amount === 250000, 'P&L groups expense by category');

  // Route gate for /finance/pl is FINANCE_PLUS → admin denied.
  const adminErr = await guardResult(FINANCE_PLUS, 'admin');
  assert.ok(adminErr instanceof AppError && adminErr.httpStatus === 403, 'admin must be 403 on P&L');
  assert.equal(await guardResult(FINANCE_PLUS, 'finance'), null, 'finance allowed on P&L');

  // Basic plan → 403 via the reports feature gate.
  await assert.rejects(
    () => asBasic(() => finance.profitAndLoss(basicTenantId, { year: YEAR }, undefined)),
    (err: unknown) => err instanceof AppError && err.httpStatus === 403 && err.code === 'FORBIDDEN',
  );
});

test('(g) reconciliation: invoiced vs collected diff', async () => {
  const r = await asPro(() => finance.reconciliation({ month: MONTH, year: YEAR }, undefined));
  assert.equal(r.totalInvoiced, 1000000);
  assert.equal(r.totalCollected, 600000);
  assert.equal(r.totalOutstanding, 400000);
  assert.equal(r.diff, 400000);
});

test('(h) sanity: PUT-expense gate is ADMIN_PLUS (admin allowed, finance denied)', async () => {
  assert.equal(await guardResult(ADMIN_PLUS, 'admin'), null, 'admin can edit expenses');
  const financeErr = await guardResult(ADMIN_PLUS, 'finance');
  assert.ok(financeErr instanceof AppError && financeErr.httpStatus === 403, 'finance cannot edit expenses');
});
