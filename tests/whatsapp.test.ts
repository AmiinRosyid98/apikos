/**
 * WhatsApp + Reminder Otomatis module tests (PRD §6.9, §6.10). Proves:
 *  (a) provider factory returns the StubProvider when no FONNTE_TOKEN is set;
 *  (b) template seed + render substitutes {vars} from resident/invoice/property context;
 *  (c) send-wa creates a `stub` message row + decrements remaining quota;
 *  (d) broadcast sends to N active residents (N rows);
 *  (e) quota exceeded → 403 PLAN_LIMIT_EXCEEDED;
 *  (f) reminder sweep pure-fn sends for a matching offset + is idempotent (second run sends 0);
 *  (g) RBAC: broadcast Manager+, template Manager+, send Admin+, logs all.
 *
 * Services + the reminder pure function are called inside a tenant-scoped AsyncLocalStorage
 * context (the same guard the API uses). RBAC is asserted by invoking rbacGuard directly.
 * Run: node --require ts-node/register --test tests/whatsapp.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as wa from '../src/modules/whatsapp/whatsapp.service';
import { renderTemplate } from '../src/modules/whatsapp/whatsapp.templates';
import { getWhatsAppProvider, resetWhatsAppProvider } from '../src/modules/whatsapp/providers/factory';
import { runReminderSweep, disconnectReminderSender } from '../src/jobs/reminderSender';
import { rbacGuard, ADMIN_PLUS, MANAGER_PLUS, ALL } from '../src/middleware/rbacGuard';
import { AppError } from '../src/utils/errors';
import type { JwtRole } from '../src/utils/jwt';

const raw = new PrismaClient();

let proTenantId: string;
let basicTenantId: string;
let propertyId: string;
let residentA: string;
let residentB: string;
let invoiceId: string;
const userId = '00000000-0000-0000-0000-0000000000c0';

function asTenant<T>(id: string, fn: () => Promise<T>) {
  return runWithTenant({ tenantId: id, userId }, fn);
}

function guardResult(roles: JwtRole[], role: JwtRole): Promise<AppError | null> {
  return new Promise((resolve) => {
    const req = { auth: { role, userId, tenantId: proTenantId } } as never;
    rbacGuard(roles)(req, {} as never, (err?: unknown) => resolve((err as AppError) ?? null));
  });
}

/** Days-from-today helper → a Date that is `delta` days after `asOf` (date-only, UTC midnight). */
function dueDateFor(asOf: Date, delta: number): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate() + delta));
}

before(async () => {
  const stamp = Date.now();
  // Pro tenant (quota 500) with property + 2 active residents (both have phones).
  const tenant = await raw.tenant.create({
    data: {
      name: `WaPro ${stamp}`,
      slug: `wa-pro-${stamp}`,
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
  proTenantId = tenant.id;

  const prop = await raw.property.create({
    data: {
      tenantId: proTenantId,
      name: 'Kos WA',
      type: 'campur',
      address: 'Jl. WA No.1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
    },
  });
  propertyId = prop.id;

  const roomA = await raw.room.create({
    data: { tenantId: proTenantId, propertyId, roomNumber: 'W1', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });
  const roomB = await raw.room.create({
    data: { tenantId: proTenantId, propertyId, roomNumber: 'W2', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });

  const today = new Date();
  const resA = await raw.resident.create({
    data: {
      tenantId: proTenantId, propertyId, roomId: roomA.id, fullName: 'Andi',
      phone: '081200001111', monthlyRent: 1000000, checkInDate: today, status: 'active',
    },
  });
  residentA = resA.id;
  const resB = await raw.resident.create({
    data: {
      tenantId: proTenantId, propertyId, roomId: roomB.id, fullName: 'Bona',
      phone: '081200002222', monthlyRent: 1000000, checkInDate: today, status: 'active',
    },
  });
  residentB = resB.id;

  // Seed default templates for the pro tenant.
  await asTenant(proTenantId, () => wa.ensureDefaultTemplates(proTenantId));

  // Basic tenant (quota 100) for the quota-exceeded test.
  const basic = await raw.tenant.create({
    data: {
      name: `WaBasic ${stamp}`,
      slug: `wa-basic-${stamp}`,
      subscriptionPlan: 'basic',
      subscriptionStatus: 'active',
      maxProperties: 1,
      maxRooms: 20,
      maxUsers: 2,
      counter: { create: {} },
    },
  });
  basicTenantId = basic.id;
});

after(async () => {
  await raw.tenant.delete({ where: { id: proTenantId } }).catch(() => {});
  await raw.tenant.delete({ where: { id: basicTenantId } }).catch(() => {});
  await raw.$disconnect();
  await disconnectReminderSender();
});

test('(a) provider factory returns StubProvider when no FONNTE_TOKEN', () => {
  resetWhatsAppProvider();
  const provider = getWhatsAppProvider();
  assert.equal(provider.name, 'stub');
});

test('(b) template render substitutes {vars}', async () => {
  // Default seeded body must exist + render.
  const body = await asTenant(proTenantId, () => wa.resolveTemplateBody('invoice_new', propertyId));
  assert.ok(body.includes('{nama_penyewa}'));
  const rendered = renderTemplate(body, {
    nama_penyewa: 'Andi',
    nomor_kamar: 'W1',
    jumlah_tagihan: 'Rp1.000.000',
    jatuh_tempo: '5 Juni 2026',
    nama_kos: 'Kos WA',
  });
  assert.ok(rendered.includes('Andi'));
  assert.ok(rendered.includes('W1'));
  assert.ok(rendered.includes('Rp1.000.000'));
  assert.ok(!rendered.includes('{nama_penyewa}'));
});

test('(c) send-wa creates a stub message row + decrements remaining quota', async () => {
  await asTenant(proTenantId, async () => {
    // Create an invoice to send.
    const inv = await raw.invoice.create({
      data: {
        tenantId: proTenantId, invoiceNumber: `INV-X-${Date.now()}`, propertyId,
        residentId: residentA, periodMonth: 6, periodYear: 2026,
        dueDate: new Date('2026-06-05'), subtotal: 1000000, totalAmount: 1000000, status: 'unpaid',
      },
    });
    invoiceId = inv.id;

    const before = await wa.getQuota(proTenantId);
    const msg = await wa.sendInvoiceWa(proTenantId, invoiceId, 'invoice_new', userId);
    assert.equal(msg.status, 'stub');
    assert.equal(msg.invoiceId, invoiceId);
    assert.ok(msg.body.includes('Andi'));

    const after = await wa.getQuota(proTenantId);
    assert.equal(after.used, before.used + 1);
    assert.equal(after.remaining as number, (before.remaining as number) - 1);
  });
});

test('(d) broadcast sends to N active residents (N rows)', async () => {
  await asTenant(proTenantId, async () => {
    const before = await raw.waMessage.count({ where: { tenantId: proTenantId, templateType: 'broadcast' } });
    const result = await wa.broadcast(
      proTenantId,
      { propertyId, body: 'Halo {nama_penyewa} di {nama_kos}', audience: 'active_residents' },
      userId,
    );
    assert.equal(result.recipients, 2); // Andi + Bona
    assert.equal(result.sent, 2);
    assert.equal(result.messages.length, 2);
    assert.ok(result.messages.every((m) => m.status === 'stub'));
    const after = await raw.waMessage.count({ where: { tenantId: proTenantId, templateType: 'broadcast' } });
    assert.equal(after, before + 2);
  });
});

test('(e) quota exceeded → 403 PLAN_LIMIT_EXCEEDED', async () => {
  await asTenant(basicTenantId, async () => {
    // Basic quota = 100. Pre-fill 100 stub messages this month so the next send is over the cap.
    const now = new Date();
    const rows = Array.from({ length: 100 }).map((_, i) => ({
      tenantId: basicTenantId,
      toPhone: '0812',
      body: `m${i}`,
      status: 'stub' as const,
      provider: 'stub',
      createdAt: now,
    }));
    await raw.waMessage.createMany({ data: rows });

    const q = await wa.getQuota(basicTenantId);
    assert.equal(q.limit, 100);
    assert.equal(q.used, 100);
    assert.equal(q.remaining, 0);

    let err: AppError | undefined;
    try {
      await wa.assertQuota(basicTenantId, 1);
    } catch (e) {
      err = e as AppError;
    }
    assert.ok(err instanceof AppError);
    assert.equal(err!.httpStatus, 403);
    assert.equal(err!.code, 'PLAN_LIMIT_EXCEEDED');
  });
});

test('(f) reminder sweep sends for a matching offset + is idempotent', async () => {
  await asTenant(proTenantId, async () => {
    // Build an asOf where residentB's invoice is exactly H-7 (dueDate = today + 7).
    const asOf = new Date('2026-09-01T08:00:00.000Z');
    const dueDate = dueDateFor(asOf, 7);
    await raw.invoice.create({
      data: {
        tenantId: proTenantId, invoiceNumber: `INV-R-${Date.now()}`, propertyId,
        residentId: residentB, periodMonth: 9, periodYear: 2026,
        dueDate, subtotal: 1000000, totalAmount: 1000000, status: 'unpaid',
      },
    });
  });

  const asOfIso = '2026-09-01T08:00:00.000Z';
  const first = await runReminderSweep({ tenantId: proTenantId, asOf: asOfIso, source: 'test' });
  assert.ok(first.totalSent >= 1, `expected >=1 sent, got ${first.totalSent}`);

  // The H-7 reminder for residentB's invoice must be recorded with the dedup key.
  const sentRow = await asTenant(proTenantId, () =>
    raw.waMessage.findFirst({
      where: { tenantId: proTenantId, residentId: residentB, reminderKey: 'reminder_due:H-7' },
    }),
  );
  assert.ok(sentRow, 'H-7 reminder row should exist');
  assert.equal(sentRow!.status, 'stub');

  // Second run on the same day → idempotent, sends 0 for that offset.
  const second = await runReminderSweep({ tenantId: proTenantId, asOf: asOfIso, source: 'test' });
  assert.equal(second.totalSent, 0, 'second run must send 0 (idempotent)');
});

test('(g) RBAC: broadcast/template Manager+, send Admin+, logs All', async () => {
  // Broadcast → Manager+ (admin denied, manager allowed).
  assert.ok((await guardResult(MANAGER_PLUS, 'admin')) instanceof AppError);
  assert.equal(await guardResult(MANAGER_PLUS, 'manager'), null);
  // Template create → Manager+.
  assert.ok((await guardResult(MANAGER_PLUS, 'finance')) instanceof AppError);
  assert.equal(await guardResult(MANAGER_PLUS, 'owner'), null);
  // Send invoice WA → Admin+ (finance denied, admin allowed).
  assert.ok((await guardResult(ADMIN_PLUS, 'finance')) instanceof AppError);
  assert.equal(await guardResult(ADMIN_PLUS, 'admin'), null);
  // Logs → All.
  assert.equal(await guardResult(ALL, 'finance'), null);
  assert.equal(await guardResult(ALL, 'admin'), null);
});
