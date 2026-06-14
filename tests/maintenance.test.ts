/**
 * Maintenance Module tests (PRD §6.14). Proves tickets + vendor DB + per-room history + the
 * cost→expense seam + RBAC:
 *  (a) create ticket → status `open` + sequential ticketNumber (TKT-YEAR-0001/0002);
 *  (b) assign a vendor via PUT (+ set cost);
 *  (c) status transitions open → in_progress → done sets resolvedAt;
 *  (d) invalid transition on a cancelled (terminal) ticket → 409 CONFLICT;
 *  (e) `done` with logAsExpense → creates a Maintenance Finance expense (once, no double-log);
 *  (f) vendor CRUD + work history aggregates assigned tickets + total cost + count;
 *  (g) per-room history returns the room's tickets (+ totalCost);
 *  (h) vendor delete: soft-deactivate when referenced by tickets;
 *  (i) RBAC: create/edit/status Admin+ (finance → 403); view All (incl. finance); vendor delete
 *      Manager+ (admin → 403).
 *
 * Services are called inside a tenant-scoped AsyncLocalStorage context (the same guard the API
 * uses). RBAC is asserted by invoking the rbacGuard middleware directly (the route layer).
 * Run: node --require ts-node/register --test tests/maintenance.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as m from '../src/modules/maintenance/maintenance.service';
import { rbacGuard, ADMIN_PLUS, ALL, MANAGER_PLUS } from '../src/middleware/rbacGuard';
import { AppError } from '../src/utils/errors';
import type { JwtRole } from '../src/utils/jwt';

const raw = new PrismaClient();

let tenantId: string;
let propertyId: string;
let roomA: string;
const userId = '00000000-0000-0000-0000-0000000000c0';
const YEAR = new Date().getUTCFullYear();

function asTenant<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId, userId }, fn);
}

function guardResult(roles: JwtRole[], role: JwtRole): Promise<AppError | null> {
  return new Promise((resolve) => {
    const req = { auth: { role, userId, tenantId } } as never;
    rbacGuard(roles)(req, {} as never, (err?: unknown) => resolve((err as AppError) ?? null));
  });
}

before(async () => {
  const stamp = Date.now();
  const tenant = await raw.tenant.create({
    data: {
      name: `MaintPro ${stamp}`,
      slug: `maint-pro-${stamp}`,
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
      name: 'Maint Kos',
      type: 'campur',
      address: 'Jl Maint 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      isActive: true,
    },
  });
  propertyId = prop.id;
  const room = await raw.room.create({
    data: { tenantId, propertyId, roomNumber: 'A1', roomType: 'standard', basePrice: 1000000 },
  });
  roomA = room.id;
});

after(async () => {
  if (tenantId) await raw.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await raw.$disconnect();
});

let ticket1: string;
let ticket2: string;
let vendorId: string;

test('(a) create ticket → open + sequential ticketNumber', async () => {
  const t1 = await asTenant(() =>
    m.createTicket(tenantId, userId, {
      propertyId,
      roomId: roomA,
      title: 'Lampu mati',
      description: 'Lampu kamar A1 tidak menyala',
      category: 'listrik',
      priority: 'medium',
      photoKeys: [],
    }),
  );
  ticket1 = t1.id;
  assert.equal(t1.status, 'open');
  assert.equal(t1.ticketNumber, `TKT-${YEAR}-0001`);
  assert.equal(t1.cost, 0);

  // A common-area (roomId null) ticket → next sequential number.
  const t2 = await asTenant(() =>
    m.createTicket(tenantId, userId, {
      propertyId,
      title: 'Atap bocor (area umum)',
      description: 'Genteng lorong bocor',
      priority: 'high',
      photoKeys: [],
    }),
  );
  ticket2 = t2.id;
  assert.equal(t2.ticketNumber, `TKT-${YEAR}-0002`);
  assert.equal(t2.roomId, null);
});

test('(b) assign a vendor + set cost via PUT', async () => {
  const v = await asTenant(() =>
    m.createVendor(tenantId, { name: 'Pak Budi - Listrik', skill: 'listrik', isActive: true }),
  );
  vendorId = v.id;
  const updated = await asTenant(() =>
    m.updateTicket(tenantId, userId, ticket1, { vendorId, cost: 150000, logAsExpense: false }),
  );
  assert.equal(updated.vendorId, vendorId);
  assert.equal(updated.cost, 150000);
  assert.equal(updated.vendor?.id, vendorId);
});

test('(c) transitions open → in_progress → done sets resolvedAt', async () => {
  const ip = await asTenant(() =>
    m.changeStatus(tenantId, userId, ticket1, { status: 'in_progress', logAsExpense: false }),
  );
  assert.equal(ip.status, 'in_progress');
  assert.equal(ip.resolvedAt, null);

  const done = await asTenant(() =>
    m.changeStatus(tenantId, userId, ticket1, { status: 'done', logAsExpense: false }),
  );
  assert.equal(done.status, 'done');
  assert.ok(done.resolvedAt, 'resolvedAt set on done');
});

test('(d) invalid transition on a cancelled ticket → 409', async () => {
  // Cancel ticket2 (open → cancelled is allowed), then any further change → 409.
  await asTenant(() => m.changeStatus(tenantId, userId, ticket2, { status: 'cancelled', logAsExpense: false }));
  await assert.rejects(
    () => asTenant(() => m.changeStatus(tenantId, userId, ticket2, { status: 'in_progress', logAsExpense: false })),
    (e: unknown) => e instanceof AppError && e.httpStatus === 409 && e.code === 'CONFLICT',
  );
});

test('(e) done with logAsExpense → creates a Maintenance expense (once)', async () => {
  // New ticket with cost, close with logAsExpense=true.
  const t = await asTenant(() =>
    m.createTicket(tenantId, userId, {
      propertyId,
      roomId: roomA,
      title: 'Ganti kran',
      description: 'Kran kamar mandi rusak',
      priority: 'low',
      photoKeys: [],
    }),
  );
  const closed = await asTenant(() =>
    m.changeStatus(tenantId, userId, t.id, { status: 'done', cost: 90000, logAsExpense: true }),
  );
  assert.equal(closed.cost, 90000);
  assert.ok(closed.expenseId, 'expenseId set after logging');

  // The expense exists in the Maintenance category, scoped to the property, amount 90000.
  const expense = await raw.expense.findFirst({
    where: { id: closed.expenseId! },
    include: { category: true },
  });
  assert.equal(Number(expense?.amount), 90000);
  assert.equal(expense?.category.name, m.MAINTENANCE_EXPENSE_CATEGORY);
  assert.equal(expense?.propertyId, propertyId);

  // Idempotency: re-logging via PUT does NOT create a second expense (guarded by expenseId).
  await asTenant(() => m.updateTicket(tenantId, userId, t.id, { cost: 90000, logAsExpense: true }));
  const ticketRow = await raw.maintenanceTicket.findFirst({ where: { id: t.id } });
  const expenses = await raw.expense.count({
    where: { tenantId, description: { startsWith: ticketRow!.ticketNumber } },
  });
  assert.equal(expenses, 1, 'no double-log');
});

test('(f) vendor work history aggregates assigned tickets + cost + count', async () => {
  const detail = await asTenant(() => m.getVendorDetail(vendorId));
  // ticket1 (cost 150000) is assigned to this vendor.
  assert.ok(detail.workHistory.ticketCount >= 1);
  assert.ok(detail.workHistory.totalCost >= 150000);
  assert.ok(detail.workHistory.tickets.some((t) => t.id === ticket1));
});

test('(g) per-room history returns the room tickets + totalCost', async () => {
  const res = await asTenant(() =>
    m.listTicketsByRoom(roomA, { page: 1, limit: 20, sort_order: 'desc' }),
  );
  assert.ok(res.total >= 2, 'room A1 has at least the lampu + kran tickets');
  assert.ok(res.rows.every((t) => t.roomId === roomA));
  assert.ok(res.totalCost >= 240000); // 150000 + 90000
});

test('(h) vendor delete soft-deactivates when referenced by tickets', async () => {
  const res = await asTenant(() => m.deleteVendor(vendorId));
  assert.equal(res.mode, 'deactivated');
  const v = await raw.vendor.findFirst({ where: { id: vendorId } });
  assert.equal(v?.isActive, false);

  // A brand-new, unreferenced vendor → hard delete.
  const fresh = await asTenant(() => m.createVendor(tenantId, { name: 'Tukang Lepas', isActive: true }));
  const del = await asTenant(() => m.deleteVendor(fresh.id));
  assert.equal(del.mode, 'deleted');
  const gone = await raw.vendor.findFirst({ where: { id: fresh.id } });
  assert.equal(gone, null);
});

test('(i) RBAC: ticket create/edit/status Admin+ (finance 403); view All; vendor delete Manager+', async () => {
  // Ticket mutation gate = ADMIN_PLUS → finance denied, admin allowed.
  assert.equal((await guardResult(ADMIN_PLUS, 'finance'))?.httpStatus, 403);
  assert.equal(await guardResult(ADMIN_PLUS, 'admin'), null);
  assert.equal(await guardResult(ADMIN_PLUS, 'owner'), null);
  // View gate = ALL → finance allowed.
  assert.equal(await guardResult(ALL, 'finance'), null);
  // Vendor delete gate = MANAGER_PLUS → admin denied, manager allowed.
  assert.equal((await guardResult(MANAGER_PLUS, 'admin'))?.httpStatus, 403);
  assert.equal(await guardResult(MANAGER_PLUS, 'manager'), null);
});
