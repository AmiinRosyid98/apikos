/**
 * Integrasi Akuntansi tests (PRD Modul 21 — Premium, STUB MODE). Exercises the FULL HTTP stack via a
 * real Express server on an ephemeral port so it proves the route guards (authGuard, tenantContext,
 * rbacGuard FINANCE_PLUS / OWNER_ONLY) AND the service-layer Premium gate fire together, plus the
 * provider seam + journal mapping + sync idempotency.
 *
 * Coverage:
 *  (a) provider factory returns the StubProvider when no real provider+key is configured;
 *  (b) journal mapping: payment → income journal (balanced debit=credit), expense → expense journal;
 *  (c) PUT /accounting/config: Premium gate (Pro → 403, Basic → 403); owner-only (manager/admin → 403);
 *      owner on PREMIUM → sets provider/enabled + testConnection ok (stub);
 *  (d) POST /accounting/sync (Premium tenant): maps the seeded payment → income + expense → expense,
 *      logs `synced` with a JRN-STUB-… ref;
 *  (e) IDEMPOTENCY: a second sync → all skipped, no duplicate rows (unique constraint holds);
 *  (f) GET /accounting/entries returns the journal log (with `lines`); GET /accounting/status counts;
 *  (g) RBAC: admin → 403 on sync AND status (finance views exclude admin).
 *
 * Run: node --require ts-node/register --test tests/accounting.test.ts   (npm run test:accounting)
 * Creates + tears down its own isolated tenants.
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { signAccessToken, type JwtRole } from '../src/utils/jwt';
import { getAccountingProvider } from '../src/modules/accounting/providers/factory';
import { mapPaymentToEntry, mapExpenseToEntry, isBalanced } from '../src/modules/accounting/mapping';

const raw = new PrismaClient();

let server: Server;
let baseUrl: string;

interface Fixture {
  tenantId: string;
  ownerToken: string;
  managerToken: string;
  adminToken: string;
  financeToken: string;
  paymentId: string;
  expenseId: string;
}

const fixtures: Record<'premium' | 'pro' | 'basic', Fixture> = {} as never;

async function mkUser(tenantId: string, role: JwtRole): Promise<string> {
  const u = await raw.user.create({
    data: {
      tenantId,
      email: `${role}-${randomUUID()}@acct.test`,
      passwordHash: 'x',
      fullName: `${role} user`,
      role,
      isActive: true,
    },
  });
  return signAccessToken({ userId: u.id, tenantId, role });
}

/** Seed a tenant with a property + resident + paid invoice + payment (income) + one expense. */
async function makeFixture(plan: 'premium' | 'pro' | 'basic'): Promise<Fixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const t = await raw.tenant.create({
    data: {
      name: `Acct ${plan} ${stamp}`,
      slug: `acct-${plan}-${stamp}`,
      subscriptionPlan: plan,
      subscriptionStatus: 'active',
      maxProperties: 50,
      maxRooms: 100,
      maxUsers: 50,
      counter: { create: {} },
    },
  });
  const property = await raw.property.create({
    data: {
      tenantId: t.id,
      name: `Kos ${plan}`,
      type: 'campur',
      address: 'Jl Acct 1',
      city: 'Jakarta',
      province: 'DKI',
      billingDay: 1,
    },
  });
  const room = await raw.room.create({
    data: { tenantId: t.id, propertyId: property.id, roomNumber: 'A1', roomType: 'standard', basePrice: 800000, status: 'occupied' },
  });
  const resident = await raw.resident.create({
    data: {
      tenantId: t.id, propertyId: property.id, roomId: room.id, fullName: 'Budi Akun',
      phone: '081200000000', monthlyRent: 800000, checkInDate: new Date(), status: 'active',
    },
  });
  const invoice = await raw.invoice.create({
    data: {
      tenantId: t.id, invoiceNumber: `INV-ACCT-${stamp}`,
      propertyId: property.id, roomId: room.id, residentId: resident.id,
      periodMonth: new Date().getMonth() + 1, periodYear: new Date().getFullYear(),
      dueDate: new Date(), subtotal: 800000, totalAmount: 800000, paidAmount: 800000, status: 'paid',
    },
  });
  const payment = await raw.payment.create({
    data: {
      tenantId: t.id, invoiceId: invoice.id, amount: 800000, method: 'cash',
      paidAt: new Date(), recordedBy: t.id,
    },
  });
  const category = await raw.expenseCategory.create({
    data: { tenantId: t.id, name: 'Listrik PLN', isDefault: true },
  });
  const expense = await raw.expense.create({
    data: {
      tenantId: t.id, propertyId: property.id, categoryId: category.id, amount: 150000,
      date: new Date(), description: 'Tagihan listrik',
    },
  });

  return {
    tenantId: t.id,
    ownerToken: await mkUser(t.id, 'owner'),
    managerToken: await mkUser(t.id, 'manager'),
    adminToken: await mkUser(t.id, 'admin'),
    financeToken: await mkUser(t.id, 'finance'),
    paymentId: payment.id,
    expenseId: expense.id,
  };
}

function api(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}
/* eslint-disable @typescript-eslint/no-explicit-any */
async function body(res: Response): Promise<any> {
  return res.json();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

before(async () => {
  fixtures.premium = await makeFixture('premium');
  fixtures.pro = await makeFixture('pro');
  fixtures.basic = await makeFixture('basic');

  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const f of Object.values(fixtures)) {
    if (f?.tenantId) await raw.tenant.delete({ where: { id: f.tenantId } }).catch(() => {});
  }
  await raw.$disconnect();
});

test('(a) provider factory returns StubProvider when no real provider+key', () => {
  assert.equal(getAccountingProvider({ accountingProvider: null, accountingApiKeyEnc: null }).name, 'stub');
  assert.equal(getAccountingProvider({ accountingProvider: 'stub', accountingApiKeyEnc: null }).name, 'stub');
  // real provider name but NO key → still Stub (never hit the network without credentials)
  assert.equal(getAccountingProvider({ accountingProvider: 'jurnal', accountingApiKeyEnc: null }).name, 'stub');
});

test('(b) journal mapping: payment → income (balanced), expense → expense (balanced)', () => {
  const income = mapPaymentToEntry({ id: randomUUID(), amount: 800000, paidAt: new Date(), invoiceNumber: 'INV-X', residentName: 'Budi' });
  assert.equal(income.entryType, 'income');
  assert.equal(income.lines.length, 2);
  assert.equal(income.lines[0].account, 'Kas/Bank');
  assert.equal(income.lines[0].debit, 800000);
  assert.equal(income.lines[1].account, 'Pendapatan Sewa');
  assert.equal(income.lines[1].credit, 800000);
  assert.ok(isBalanced(income.lines), 'income journal balances');

  const expense = mapExpenseToEntry({ id: randomUUID(), amount: 150000, date: new Date(), categoryName: 'Listrik PLN', description: 'x' });
  assert.equal(expense.entryType, 'expense');
  assert.equal(expense.lines[0].account, 'Beban Listrik PLN');
  assert.equal(expense.lines[0].debit, 150000);
  assert.equal(expense.lines[1].account, 'Kas/Bank');
  assert.equal(expense.lines[1].credit, 150000);
  assert.ok(isBalanced(expense.lines), 'expense journal balances');
});

test('(c) PUT /accounting/config: Premium gate (Pro/Basic → 403), owner-only (manager/admin → 403)', async () => {
  // Pro tenant owner → 403 (not Premium).
  const proRes = await api('/accounting/config', fixtures.pro.ownerToken, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  assert.equal(proRes.status, 403);
  assert.equal((await body(proRes)).code, 'FORBIDDEN');

  // Basic tenant owner → 403.
  const basicRes = await api('/accounting/config', fixtures.basic.ownerToken, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  assert.equal(basicRes.status, 403);

  // Premium tenant: manager + admin → 403 (owner-only).
  for (const tok of [fixtures.premium.managerToken, fixtures.premium.adminToken]) {
    const res = await api('/accounting/config', tok, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    assert.equal(res.status, 403, 'non-owner config PUT must be 403');
    assert.equal((await body(res)).code, 'FORBIDDEN');
  }

  // Premium owner → ok: set provider stub + enable + testConnection.
  const ok = await api('/accounting/config', fixtures.premium.ownerToken, {
    method: 'PUT',
    body: JSON.stringify({ provider: 'stub', enabled: true, testConnection: true }),
  });
  assert.equal(ok.status, 200);
  const json = await body(ok);
  assert.equal(json.data.provider, 'stub');
  assert.equal(json.data.enabled, true);
  assert.equal(json.data.connected, false, 'stub is not a "connected" real provider');
  assert.equal(json.data.testConnection.ok, true);
});

test('(d) POST /accounting/sync (Premium): payment→income + expense→expense, synced w/ stub ref', async () => {
  const res = await api('/accounting/sync', fixtures.premium.financeToken, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(res.status, 200);
  const json = await body(res);
  assert.equal(json.data.synced, 2, 'one payment + one expense synced');
  assert.equal(json.data.skipped, 0);
  assert.equal(json.data.failed, 0);

  const rows = await raw.accountingEntry.findMany({ where: { tenantId: fixtures.premium.tenantId } });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.status, 'synced');
    assert.equal(r.provider, 'stub');
    assert.ok(r.journalRef?.startsWith('JRN-STUB-'), `ref is a stub ref: ${r.journalRef}`);
    assert.ok(r.syncedAt instanceof Date);
  }
  const types = rows.map((r) => r.entryType).sort();
  assert.deepEqual(types, ['expense', 'income']);
});

test('(e) IDEMPOTENCY: second sync → all skipped, no duplicate (unique constraint holds)', async () => {
  const res = await api('/accounting/sync', fixtures.premium.ownerToken, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(res.status, 200);
  const json = await body(res);
  assert.equal(json.data.synced, 0, 'nothing re-synced');
  assert.equal(json.data.skipped, 2, 'both already-synced entities skipped');

  const count = await raw.accountingEntry.count({ where: { tenantId: fixtures.premium.tenantId } });
  assert.equal(count, 2, 'no duplicate journal rows');
});

test('(f) GET /accounting/entries (with lines) + /accounting/status counts', async () => {
  const entriesRes = await api('/accounting/entries', fixtures.premium.managerToken);
  assert.equal(entriesRes.status, 200);
  const entries = await body(entriesRes);
  assert.equal(entries.meta.total, 2);
  for (const e of entries.data) {
    assert.ok(Array.isArray(e.lines) && e.lines.length === 2, 'entry carries the double-entry lines');
  }
  // filter by type
  const incomeOnly = await body(await api('/accounting/entries?type=income', fixtures.premium.managerToken));
  assert.equal(incomeOnly.data.length, 1);
  assert.equal(incomeOnly.data[0].entryType, 'income');

  const statusRes = await api('/accounting/status', fixtures.premium.ownerToken);
  assert.equal(statusRes.status, 200);
  const status = await body(statusRes);
  assert.equal(status.data.provider, 'stub');
  assert.equal(status.data.enabled, true);
  assert.equal(status.data.counts.synced, 2);
  assert.equal(status.data.counts.failed, 0);
  assert.notEqual(status.data.lastSyncedAt, null);
});

test('(g) RBAC: admin → 403 on sync AND status (finance views exclude admin)', async () => {
  const sync = await api('/accounting/sync', fixtures.premium.adminToken, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(sync.status, 403);
  assert.equal((await body(sync)).code, 'FORBIDDEN');

  const status = await api('/accounting/status', fixtures.premium.adminToken);
  assert.equal(status.status, 403);
  assert.equal((await body(status)).code, 'FORBIDDEN');
});
