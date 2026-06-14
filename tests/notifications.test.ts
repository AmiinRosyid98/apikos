/**
 * In-App Notification module tests (PRD §6.18). Proves notify() recipient resolution + preference
 * filtering + per-user isolation + the read/badge endpoints + the emit hooks:
 *  (a) payment-success emit (payment_received) → notifies the right roles (owner/manager/finance)
 *      and NOT excluded roles (admin);
 *  (b) booking create emit (booking_new) → owner/manager/admin, NOT finance;
 *  (c) critical maintenance ticket → maintenance_critical for owner/manager/admin; a non-critical
 *      ticket creates NONE;
 *  (d) unread-count reflects creation; markRead + markAllRead flip state;
 *  (e) preference OFF for a type → no notification created for that user;
 *  (f) per-user isolation: user A cannot read/mark user B's notification → 404; list is scoped to
 *      the caller;
 *  (g) contract_expiring sweep emit + idempotency (dedupe → second run creates none).
 *
 * Services are called inside a tenant-scoped AsyncLocalStorage context (the same guard the API uses).
 * Run: node --require ts-node/register --test tests/notifications.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import { notify } from '../src/services/notification.service';
import * as svc from '../src/modules/notifications/notifications.service';
import { createTicket } from '../src/modules/maintenance/maintenance.service';
import { createBooking } from '../src/modules/bookings/bookings.service';
import { emitPaymentReceivedNotification } from '../src/modules/payments/payment-gateway.service';
import { emitContractExpiringNotifications } from '../src/jobs/reminderSender';
import { AppError } from '../src/utils/errors';

const raw = new PrismaClient();

let tenantId: string;
let propertyId: string;
let roomEmpty: string;
let roomOcc: string;
let residentId: string;
let invoiceId: string;
const users: Record<string, string> = {}; // role → userId

function asTenant<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId, userId: users.owner }, fn);
}

before(async () => {
  const stamp = Date.now();
  const tenant = await raw.tenant.create({
    data: {
      name: `NotifPro ${stamp}`,
      slug: `notif-pro-${stamp}`,
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
  tenantId = tenant.id;

  for (const role of ['owner', 'manager', 'admin', 'finance'] as const) {
    const u = await raw.user.create({
      data: {
        tenantId,
        email: `${role}-${stamp}@notif.kos`,
        passwordHash: 'x',
        fullName: `Notif ${role}`,
        role,
        isActive: true,
      },
    });
    users[role] = u.id;
  }

  const prop = await raw.property.create({
    data: {
      tenantId,
      name: 'Notif Kos',
      type: 'campur',
      address: 'Jl Notif 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      isActive: true,
    },
  });
  propertyId = prop.id;

  const rEmpty = await raw.room.create({
    data: { tenantId, propertyId, roomNumber: 'A1', roomType: 'standard', basePrice: 1000000, status: 'empty' },
  });
  roomEmpty = rEmpty.id;
  const rOcc = await raw.room.create({
    data: { tenantId, propertyId, roomNumber: 'A2', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });
  roomOcc = rOcc.id;

  const resident = await raw.resident.create({
    data: {
      tenantId,
      propertyId,
      roomId: roomOcc,
      fullName: 'Budi Test',
      phone: '0812000',
      monthlyRent: 1000000,
      checkInDate: new Date(),
      status: 'active',
    },
  });
  residentId = resident.id;

  const now = new Date();
  const invoice = await raw.invoice.create({
    data: {
      tenantId,
      invoiceNumber: `INV-${now.getFullYear()}-NOTIF1`,
      propertyId,
      roomId: roomOcc,
      residentId,
      periodMonth: now.getMonth() + 1,
      periodYear: now.getFullYear(),
      dueDate: now,
      subtotal: 800000,
      lateFee: 0,
      totalAmount: 800000,
      paidAmount: 800000,
      status: 'paid',
    },
  });
  invoiceId = invoice.id;
});

after(async () => {
  if (tenantId) await raw.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await raw.$disconnect();
});

async function countFor(role: string, type?: string): Promise<number> {
  return raw.notification.count({
    where: { tenantId, userId: users[role], ...(type ? { type: type as never } : {}) },
  });
}

test('(a) payment_received emit → owner/manager/finance, NOT admin', async () => {
  await asTenant(() => emitPaymentReceivedNotification(tenantId, invoiceId, 800000));
  assert.equal(await countFor('owner', 'payment_received'), 1);
  assert.equal(await countFor('manager', 'payment_received'), 1);
  assert.equal(await countFor('finance', 'payment_received'), 1);
  assert.equal(await countFor('admin', 'payment_received'), 0, 'admin excluded from payment_received');
  // The row carries a deep link to the invoice.
  const n = await raw.notification.findFirst({
    where: { tenantId, userId: users.owner, type: 'payment_received' },
  });
  assert.equal(n?.link, `/invoices/${invoiceId}`);
  assert.match(n?.body ?? '', /Rp/);
});

test('(b) booking_new emit → owner/manager/admin, NOT finance', async () => {
  await asTenant(() =>
    createBooking(tenantId, users.owner, {
      roomId: roomEmpty,
      prospectName: 'Andi Prospect',
      prospectPhone: '08120001',
      bookingFeeAmount: 100000,
      bookingFeeMethod: 'transfer',
      plannedCheckInDate: new Date().toISOString().slice(0, 10),
    } as never),
  );
  assert.equal(await countFor('owner', 'booking_new'), 1);
  assert.equal(await countFor('manager', 'booking_new'), 1);
  assert.equal(await countFor('admin', 'booking_new'), 1);
  assert.equal(await countFor('finance', 'booking_new'), 0, 'finance excluded from booking_new');
});

test('(c) critical maintenance ticket → maintenance_critical; non-critical → none', async () => {
  // Non-critical: no notification.
  await asTenant(() =>
    createTicket(tenantId, users.owner, {
      propertyId,
      roomId: roomOcc,
      title: 'Keran bocor',
      description: 'Air menetes',
      priority: 'medium',
      photoKeys: [],
    } as never),
  );
  assert.equal(await countFor('owner', 'maintenance_critical'), 0, 'non-critical → no notification');

  // Critical: notifies owner/manager/admin, not finance.
  await asTenant(() =>
    createTicket(tenantId, users.owner, {
      propertyId,
      roomId: roomOcc,
      title: 'Korsleting listrik',
      description: 'Bahaya kebakaran',
      priority: 'critical',
      photoKeys: [],
    } as never),
  );
  assert.equal(await countFor('owner', 'maintenance_critical'), 1);
  assert.equal(await countFor('manager', 'maintenance_critical'), 1);
  assert.equal(await countFor('admin', 'maintenance_critical'), 1);
  assert.equal(await countFor('finance', 'maintenance_critical'), 0, 'finance excluded');
});

test('(d) unread-count + markRead + markAllRead', async () => {
  await asTenant(async () => {
    const before = await svc.unreadCount(users.owner);
    assert.ok(before >= 3, 'owner has unread notifications from (a)-(c)');

    // Mark one read → unread count drops by 1.
    const one = await raw.notification.findFirst({
      where: { tenantId, userId: users.owner, isRead: false },
    });
    const marked = await svc.markRead(users.owner, one!.id);
    assert.equal(marked.isRead, true);
    assert.ok(marked.readAt);
    const afterOne = await svc.unreadCount(users.owner);
    assert.equal(afterOne, before - 1);

    // Mark all read → 0 unread.
    const flipped = await svc.markAllRead(users.owner);
    assert.equal(flipped, afterOne);
    assert.equal(await svc.unreadCount(users.owner), 0);
  });
});

test('(e) preference OFF for a type → no notification created', async () => {
  // Disable booking_new for the manager.
  await asTenant(() =>
    svc.updatePreferences(users.manager, { booking_new: false }),
  );
  const before = await countFor('manager', 'booking_new');
  await asTenant(() =>
    notify({
      tenantId,
      type: 'booking_new',
      title: 'X',
      body: 'Y',
    }),
  );
  // Manager opted out → unchanged; owner (still enabled) increments.
  assert.equal(await countFor('manager', 'booking_new'), before, 'manager opted out → none');
  // Effective prefs reflect the toggle.
  const prefs = await asTenant(() => svc.getPreferences(users.manager));
  assert.equal(prefs.preferences.booking_new, false);
  assert.equal(prefs.preferences.payment_received, true, 'untoggled type stays enabled');
});

test('(f) per-user isolation: A cannot read/mark B notification → 404; list scoped to caller', async () => {
  await asTenant(async () => {
    const ownerNote = await raw.notification.create({
      data: { tenantId, userId: users.owner, type: 'general', title: 'O', body: 'O' },
    });
    // Admin tries to mark the owner's notification → 404 (no existence leak).
    await assert.rejects(
      () => svc.markRead(users.admin, ownerNote.id),
      (e) => e instanceof AppError && e.httpStatus === 404,
    );
    // Admin's list never contains the owner's row.
    const adminList = await svc.listForUser(users.admin, {
      page: 1,
      limit: 100,
      sort_order: 'desc',
    } as never);
    assert.ok(!adminList.rows.some((r) => r.id === ownerNote.id), 'admin list excludes owner row');
  });
});

test('(g) contract_expiring sweep emit + idempotency (dedupe)', async () => {
  // Set the resident contract to expire in 20 days → inside the 30-day window.
  const asOf = new Date();
  const end = new Date(asOf.getTime() + 20 * 86_400_000);
  await raw.resident.update({ where: { id: residentId }, data: { contractEndDate: end } });

  const first = await asTenant(() =>
    emitContractExpiringNotifications(tenantId, propertyId, 'Notif Kos', asOf),
  );
  assert.ok(first >= 1, 'first run emits for owner/manager');
  const ownerBefore = await countFor('owner', 'contract_expiring');
  assert.equal(ownerBefore, 1);

  // Second run with the same unread notification present → dedupe → none added.
  await asTenant(() =>
    emitContractExpiringNotifications(tenantId, propertyId, 'Notif Kos', asOf),
  );
  assert.equal(await countFor('owner', 'contract_expiring'), 1, 'idempotent: no duplicate while unread');

  // contract_expiring goes to owner/manager only — admin/finance excluded.
  assert.equal(await countFor('admin', 'contract_expiring'), 0);
  assert.equal(await countFor('finance', 'contract_expiring'), 0);
});
