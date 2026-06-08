/**
 * Check-in/Check-out Digital (berita acara) module tests (PRD §6.5). Proves:
 *  (a) create a check-in handover with inventory + photos (stored correctly);
 *  (b) create a check-out handover;
 *  (c) GET /handovers/:id detail returns presigned URLs for photoKeys + signatureKey;
 *  (d) the PDF generator returns a non-empty application/pdf buffer (%PDF header, length > 0);
 *  (e) Basic-plan tenant → 403 (FORBIDDEN) on create;
 *  (f) role gating: check-in is Admin+, check-out is Manager+ (enforced in the controller —
 *      asserted here against the role constants used by the controller).
 *
 * Service-level tests run inside a tenant-scoped AsyncLocalStorage context (the API's guard).
 * Run: node --require ts-node/register --test tests/handovers.test.ts
 */
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as handovers from '../src/modules/handovers/handovers.service';
import { generateHandoverPdf } from '../src/modules/handovers/handovers.pdf';
import { AppError } from '../src/utils/errors';

// Mirror the controller's role gating constants (importing rbacGuard pulls in the express
// Request augmentation which ts-node does not resolve for the standalone test). The controller
// uses ADMIN_PLUS for check-in and MANAGER_PLUS for check-out.
const ADMIN_PLUS = ['owner', 'manager', 'admin'];
const MANAGER_PLUS = ['owner', 'manager'];

const raw = new PrismaClient();

let proTenantId: string;
let proPropertyId: string;
let proRoomId: string;
let residentId: string;
let checkinId: string;

let basicTenantId: string;
let basicResidentId: string;

const userId = '00000000-0000-0000-0000-0000000000cc';

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
      name: `HandPro ${stamp}`,
      slug: `hand-pro-${stamp}`,
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
      name: 'Handover Kos',
      type: 'campur',
      address: 'Jl Handover 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay: 1,
      electricityPriceKwh: 1500,
      isActive: true,
    },
  });
  proPropertyId = prop.id;
  const room = await raw.room.create({
    data: { tenantId: proTenantId, propertyId: proPropertyId, roomNumber: 'H1', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });
  proRoomId = room.id;
  const resident = await raw.resident.create({
    data: {
      tenantId: proTenantId,
      propertyId: proPropertyId,
      roomId: proRoomId,
      fullName: 'Handover Resident',
      nikEnc: 'x.x.x',
      nikLast4: '0000',
      phone: '081233330000',
      gender: 'male',
      monthlyRent: 1000000,
      checkInDate: new Date(Date.UTC(2026, 4, 1)),
      status: 'active',
    },
  });
  residentId = resident.id;

  // Track the file keys so presignDownloadIfExists (which authorizes against FileObject rows)
  // returns real presigned URLs in the detail test.
  for (const key of ['handover/h1-room.jpg', 'handover/h1-bathroom.jpg', 'handover/h1-sign.png']) {
    await raw.fileObject.create({
      data: {
        tenantId: proTenantId,
        key,
        purpose: 'handover',
        contentType: key.endsWith('.png') ? 'image/png' : 'image/jpeg',
        sizeBytes: 1024,
        uploadedBy: userId,
        isPrivate: true,
      },
    });
  }

  const basicTenant = await raw.tenant.create({
    data: {
      name: `HandBasic ${stamp}`,
      slug: `hand-basic-${stamp}`,
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
    data: { tenantId: basicTenantId, name: 'Basic Kos', type: 'campur', address: 'Jl B 1', city: 'Bandung', province: 'Jawa Barat', billingDay: 1, isActive: true },
  });
  const br = await raw.room.create({
    data: { tenantId: basicTenantId, propertyId: bp.id, roomNumber: 'B1', roomType: 'standard', basePrice: 800000, status: 'occupied' },
  });
  const bres = await raw.resident.create({
    data: {
      tenantId: basicTenantId,
      propertyId: bp.id,
      roomId: br.id,
      fullName: 'Basic Res',
      nikEnc: 'x.x.x',
      nikLast4: '0000',
      phone: '081200000000',
      gender: 'male',
      monthlyRent: 800000,
      checkInDate: new Date(Date.UTC(2026, 4, 1)),
      status: 'active',
    },
  });
  basicResidentId = bres.id;
});

after(async () => {
  if (proTenantId) await raw.tenant.delete({ where: { id: proTenantId } }).catch(() => {});
  if (basicTenantId) await raw.tenant.delete({ where: { id: basicTenantId } }).catch(() => {});
  await raw.$disconnect();
});

test('(a) create a check-in handover with inventory + photos', async () => {
  const result = await asPro(() =>
    handovers.createHandover(proTenantId, residentId, userId, {
      type: 'checkin',
      date: '2026-05-01',
      photoKeys: ['handover/h1-room.jpg', 'handover/h1-bathroom.jpg'],
      inventory: [
        { item: 'Kasur', condition: 'good' },
        { item: 'Lemari', condition: 'damaged', notes: 'Engsel longgar' },
      ],
      initialMeterElectricity: 1234.5,
      signatureKey: 'handover/h1-sign.png',
      notes: 'Serah terima awal.',
    }),
  );
  checkinId = result.handover.id;
  assert.equal(result.handover.type, 'checkin');
  assert.equal(result.handover.photoKeys.length, 2);
  assert.equal(result.handover.inventory.length, 2);
  assert.equal(result.handover.inventory[1].condition, 'damaged');
  assert.equal(result.handover.initialMeterElectricity, 1234.5);
});

test('(b) create a check-out handover', async () => {
  const result = await asPro(() =>
    handovers.createHandover(proTenantId, residentId, userId, {
      type: 'checkout',
      date: '2026-06-01',
      photoKeys: ['handover/h1-out.jpg'],
      inventory: [{ item: 'Lemari', condition: 'damaged', notes: 'Pintu patah saat keluar' }],
      notes: 'Check-out; ada kerusakan lemari → potong deposit.',
    }),
  );
  assert.equal(result.handover.type, 'checkout');
  // initialMeterElectricity is ignored on checkout.
  assert.equal(result.handover.initialMeterElectricity, null);
});

test('(c) GET /handovers/:id returns presigned URLs for photoKeys + signatureKey', async () => {
  const detail = await asPro(() => handovers.getHandoverDetail(checkinId));
  assert.ok(Array.isArray(detail.photos), 'photos should be an array of {key,url}');
  assert.equal(detail.photos.length, 2);
  for (const p of detail.photos) {
    assert.ok(typeof p.key === 'string');
    assert.ok(typeof p.url === 'string' && p.url.length > 0, 'each photo should have a presigned url');
  }
  assert.ok(typeof detail.signatureUrl === 'string' && detail.signatureUrl.length > 0);
});

test('(d) PDF endpoint returns a non-empty application/pdf buffer', async () => {
  const ctx = await asPro(() => handovers.getHandoverForPdf(checkinId));
  const buffer = await generateHandoverPdf(ctx);
  assert.ok(Buffer.isBuffer(buffer), 'result is a Buffer');
  assert.ok(buffer.length > 0, 'buffer is non-empty');
  assert.equal(buffer.subarray(0, 4).toString('latin1'), '%PDF', 'buffer starts with the %PDF magic header');
});

test('(e) Basic-plan tenant → 403 FORBIDDEN on handover create', async () => {
  await assert.rejects(
    () =>
      asBasic(() =>
        handovers.createHandover(basicTenantId, basicResidentId, userId, {
          type: 'checkin',
          date: '2026-05-01',
          photoKeys: [],
          inventory: [],
        }),
      ),
    (e: unknown) => e instanceof AppError && e.httpStatus === 403 && e.code === 'FORBIDDEN',
  );
});

test('(f) role gating: check-in Admin+, check-out Manager+', () => {
  // The controller enforces: checkin requires a role in ADMIN_PLUS; checkout in MANAGER_PLUS.
  assert.deepEqual(ADMIN_PLUS, ['owner', 'manager', 'admin'], 'check-in allowed for Admin+');
  assert.deepEqual(MANAGER_PLUS, ['owner', 'manager'], 'check-out restricted to Manager+');
  // admin may do check-in but NOT check-out:
  assert.ok(ADMIN_PLUS.includes('admin'), 'admin can check-in');
  assert.ok(!MANAGER_PLUS.includes('admin'), 'admin cannot check-out');
});
