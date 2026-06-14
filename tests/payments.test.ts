/**
 * Payment Gateway module tests (PRD §6.8, STUB mode). Proves:
 *  (a) provider factory returns the StubProvider when no MIDTRANS_SERVER_KEY is set;
 *  (b) create charge for an unpaid invoice → a pending txn + rendered instructions;
 *  (c) method-not-in-plan → 403 PLAN_LIMIT (a Basic tenant requesting VA);
 *  (d) webhook `paid` → records a Payment + invoice becomes `paid` + txn `paid`;
 *  (e) idempotency: a replayed `paid` webhook records NO second payment (invoice paid once);
 *  (f) simulate endpoint drives the same paid flow;
 *  (g) reconciliation matches the paid txn;
 *  (h) RBAC: charge Admin+ (finance denied); reconciliation excludes admin; simulate owner/admin;
 *  (i) plan methods: Basic [qris], Pro [qris+va], Premium [all].
 *
 * Services + the provider are called inside a tenant-scoped AsyncLocalStorage context (the same
 * guard the API uses). RBAC is asserted by invoking rbacGuard directly.
 * Run: node --require ts-node/register --test tests/payments.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as pg from '../src/modules/payments/payment-gateway.service';
import {
  getPaymentProvider,
  resetPaymentProvider,
} from '../src/modules/payments/providers/factory';
import { allowedMethodsForPlan } from '../src/services/plan.service';
import { rbacGuard, ADMIN_PLUS, FINANCE_PLUS } from '../src/middleware/rbacGuard';
import { AppError } from '../src/utils/errors';
import type { JwtRole } from '../src/utils/jwt';

const raw = new PrismaClient();

let proTenantId: string;
let basicTenantId: string;
let proInvoiceId: string; // the unpaid invoice to charge (Rp800.000-style)
let basicInvoiceId: string;
const userId = '00000000-0000-0000-0000-0000000000d0';

function asTenant<T>(id: string, fn: () => Promise<T>) {
  return runWithTenant({ tenantId: id, userId }, fn);
}

function guardResult(roles: JwtRole[], role: JwtRole): Promise<AppError | null> {
  return new Promise((resolve) => {
    const req = { auth: { role, userId, tenantId: proTenantId } } as never;
    rbacGuard(roles)(req, {} as never, (err?: unknown) => resolve((err as AppError) ?? null));
  });
}

async function makeTenant(plan: 'basic' | 'pro' | 'premium', stamp: string) {
  return raw.tenant.create({
    data: {
      name: `Pay${plan} ${stamp}`,
      slug: `pay-${plan}-${stamp}`,
      subscriptionPlan: plan,
      subscriptionStatus: 'active',
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
}

async function makePropertyWithInvoice(tenantId: string, total: number) {
  const property = await raw.property.create({
    data: {
      tenantId,
      name: 'Kos Pay',
      type: 'campur',
      address: 'Jl. Pay No.1',
      city: 'Jakarta',
      province: 'DKI Jakarta',
      billingDay: 1,
    },
  });
  const room = await raw.room.create({
    data: { tenantId, propertyId: property.id, roomNumber: 'P1', roomType: 'standard', basePrice: total, status: 'occupied' },
  });
  const resident = await raw.resident.create({
    data: {
      tenantId, propertyId: property.id, roomId: room.id, fullName: 'Budi Bayar',
      phone: '081299990000', monthlyRent: total, checkInDate: new Date(), status: 'active',
    },
  });
  const invoice = await raw.invoice.create({
    data: {
      tenantId, invoiceNumber: `INV-PAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      propertyId: property.id, roomId: room.id, residentId: resident.id,
      periodMonth: new Date().getMonth() + 1, periodYear: new Date().getFullYear(),
      dueDate: new Date(), subtotal: total, totalAmount: total, paidAmount: 0, status: 'unpaid',
    },
  });
  return { property, invoice };
}

before(async () => {
  resetPaymentProvider();
  const stamp = `${Date.now()}`;
  const pro = await makeTenant('pro', stamp);
  proTenantId = pro.id;
  const proSetup = await makePropertyWithInvoice(proTenantId, 800000);
  proInvoiceId = proSetup.invoice.id;

  const basic = await makeTenant('basic', stamp);
  basicTenantId = basic.id;
  const basicSetup = await makePropertyWithInvoice(basicTenantId, 500000);
  basicInvoiceId = basicSetup.invoice.id;
});

after(async () => {
  await raw.tenant.delete({ where: { id: proTenantId } }).catch(() => {});
  await raw.tenant.delete({ where: { id: basicTenantId } }).catch(() => {});
  await raw.$disconnect();
});

test('(a) provider factory returns StubProvider when no MIDTRANS_SERVER_KEY', () => {
  resetPaymentProvider();
  assert.equal(getPaymentProvider().name, 'stub');
});

test('(i) plan methods: Basic [qris], Pro [qris+va], Premium [all]', () => {
  assert.deepEqual(allowedMethodsForPlan('basic'), ['qris']);
  const pro = allowedMethodsForPlan('pro');
  assert.ok(pro.includes('qris') && pro.includes('va_bca') && !pro.includes('gopay'));
  const premium = allowedMethodsForPlan('premium');
  assert.ok(premium.includes('qris') && premium.includes('va_bca') && premium.includes('gopay'));
});

test('(b) create charge for the unpaid invoice → pending txn + instructions', async () => {
  await asTenant(proTenantId, async () => {
    const txn = await pg.createCharge(proTenantId, proInvoiceId, 'qris');
    assert.equal(txn.status, 'pending');
    assert.equal(txn.provider, 'stub');
    assert.equal(txn.method, 'qris');
    assert.equal(txn.amount, 800000);
    assert.ok(txn.providerRef.startsWith('STUB-'));
    const ins = txn.instructions as { type: string; qrString?: string };
    assert.equal(ins.type, 'qris');
    assert.ok(ins.qrString && ins.qrString.length > 10, 'qrString should be a fake QR payload');
  });
});

test('(c) method-not-in-plan → 403 PLAN_LIMIT (Basic tenant requesting VA)', async () => {
  await asTenant(basicTenantId, async () => {
    let err: AppError | undefined;
    try {
      await pg.createCharge(basicTenantId, basicInvoiceId, 'va_bca');
    } catch (e) {
      err = e as AppError;
    }
    assert.ok(err instanceof AppError, 'expected an AppError');
    assert.equal(err!.httpStatus, 403);
    assert.equal(err!.code, 'PLAN_LIMIT_EXCEEDED');
    // Basic CAN charge QRIS.
    const ok = await pg.createCharge(basicTenantId, basicInvoiceId, 'qris');
    assert.equal(ok.status, 'pending');
  });
});

test('(d)+(e) webhook paid → records Payment + invoice paid + txn paid + idempotent on replay', async () => {
  // Use a fresh invoice (full lifecycle) inside the pro tenant.
  const setup = await makePropertyWithInvoice(proTenantId, 800000);
  const invoiceId = setup.invoice.id;

  await asTenant(proTenantId, async () => {
    const txn = await pg.createCharge(proTenantId, invoiceId, 'qris');

    // Simulate the provider verifying + delivering a `paid` webhook.
    const verified = await getPaymentProvider().verifyWebhook(
      { providerRef: txn.providerRef, status: 'paid', amount: 800000 },
      {},
    );
    assert.ok(verified, 'stub verifyWebhook should parse the payload');

    const first = await pg.applyVerifiedWebhook(verified!);
    assert.equal(first.handled, true);
    assert.equal(first.status, 'paid');
    assert.ok(first.paymentId, 'a Payment row should be linked');

    // Invoice is now paid; exactly one payment recorded; txn paid + linked.
    const inv1 = await raw.invoice.findUnique({ where: { id: invoiceId } });
    assert.equal(inv1!.status, 'paid');
    assert.equal(Number(inv1!.paidAmount), 800000);
    const payCount1 = await raw.payment.count({ where: { invoiceId } });
    assert.equal(payCount1, 1);
    const txnRow1 = await raw.paymentGatewayTxn.findUnique({ where: { providerRef: txn.providerRef } });
    assert.equal(txnRow1!.status, 'paid');
    assert.equal(txnRow1!.paymentId, first.paymentId);

    // ── REPLAY the same webhook → idempotent no-op (no second payment, invoice still paid once). ──
    const second = await pg.applyVerifiedWebhook(verified!);
    assert.equal(second.idempotent, true);
    assert.equal(second.handled, false);
    const payCount2 = await raw.payment.count({ where: { invoiceId } });
    assert.equal(payCount2, 1, 'replay must NOT record a second payment');
    const inv2 = await raw.invoice.findUnique({ where: { id: invoiceId } });
    assert.equal(Number(inv2!.paidAmount), 800000, 'invoice still paid exactly once');
  });
});

test('(f) simulate endpoint drives the same paid flow', async () => {
  const setup = await makePropertyWithInvoice(proTenantId, 600000);
  const invoiceId = setup.invoice.id;

  await asTenant(proTenantId, async () => {
    const txn = await pg.createCharge(proTenantId, invoiceId, 'qris');
    const txnRow = await raw.paymentGatewayTxn.findUnique({ where: { providerRef: txn.providerRef } });

    const result = await pg.simulateTxn(txnRow!.id, 'paid');
    assert.equal(result.status, 'paid');
    assert.ok(result.paymentId);

    const inv = await raw.invoice.findUnique({ where: { id: invoiceId } });
    assert.equal(inv!.status, 'paid');
    assert.equal(Number(inv!.paidAmount), 600000);
  });
});

test('(g) reconciliation matches the paid txn', async () => {
  await asTenant(proTenantId, async () => {
    const now = new Date();
    const recon = await pg.reconcile(
      { month: now.getMonth() + 1, year: now.getFullYear() },
      undefined,
    );
    // We paid at least 2 invoices above (webhook + simulate) this period.
    assert.ok(recon.gateway.paidTxnCount >= 2, `expected >=2 paid txns, got ${recon.gateway.paidTxnCount}`);
    assert.equal(recon.gateway.unmatchedCount, 0, 'all paid txns should be matched to a Payment');
    assert.equal(recon.reconciled, true, 'no mismatch flags expected');
    assert.ok(recon.payments.gatewayPaymentCount >= 2);
  });
});

test('(h) RBAC: charge Admin+ (finance denied); reconciliation excludes admin', async () => {
  // Charge → Admin+ (finance denied, admin allowed).
  assert.ok((await guardResult(ADMIN_PLUS, 'finance')) instanceof AppError);
  assert.equal(await guardResult(ADMIN_PLUS, 'admin'), null);
  // Reconciliation → FINANCE_PLUS (admin denied, finance allowed).
  assert.ok((await guardResult(FINANCE_PLUS, 'admin')) instanceof AppError);
  assert.equal(await guardResult(FINANCE_PLUS, 'finance'), null);
  // Simulate → owner/admin (manager + finance denied).
  assert.ok((await guardResult(['owner', 'admin'], 'manager')) instanceof AppError);
  assert.ok((await guardResult(['owner', 'admin'], 'finance')) instanceof AppError);
  assert.equal(await guardResult(['owner', 'admin'], 'owner'), null);
});
