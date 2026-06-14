/**
 * Dokumen & Kontrak Module tests (PRD §6.15). Proves templates + render, contract generation +
 * numbering + body snapshot, sign, status transitions, PDF, documents + expiry, and RBAC:
 *  (a) template create + render substitutes {vars} from resident/room/property;
 *  (b) POST /residents/:id/contract generates a contract: sequential KTR number + rendered body
 *      snapshot containing the resident's name + rent;
 *  (c) sign → status `signed` + signedAt + signature keys stored;
 *  (d) invalid transition (sign a terminated contract) → 409 CONFLICT;
 *  (e) GET /contracts/:id/pdf returns a non-empty application/pdf buffer (%PDF + len>0);
 *  (f) document create + documents/expiring returns a doc expiring within the window;
 *  (g) RBAC: template/sign Manager+, generate Admin+, view All (incl. finance), document delete
 *      Manager+.
 *
 * Services are called inside a tenant-scoped AsyncLocalStorage context (the same guard the API
 * uses). RBAC is asserted by invoking the rbacGuard middleware directly (the route layer).
 * Run: node --require ts-node/register --test tests/contracts.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import * as c from '../src/modules/contracts/contracts.service';
import { generateContractPdf } from '../src/modules/contracts/contracts.pdf';
import { rbacGuard, ADMIN_PLUS, ALL, MANAGER_PLUS } from '../src/middleware/rbacGuard';
import { AppError } from '../src/utils/errors';
import { encryptNullable } from '../src/utils/crypto';
import type { JwtRole } from '../src/utils/jwt';

const raw = new PrismaClient();

let tenantId: string;
let propertyId: string;
let roomId: string;
let residentId: string;
const userId = '00000000-0000-0000-0000-0000000000d0';
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
      name: `KontrakPro ${stamp}`,
      slug: `kontrak-pro-${stamp}`,
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
      name: 'Kos Mawar',
      type: 'campur',
      address: 'Jl Mawar 7',
      city: 'Yogyakarta',
      province: 'DIY',
      billingDay: 1,
      isActive: true,
    },
  });
  propertyId = prop.id;
  const room = await raw.room.create({
    data: { tenantId, propertyId, roomNumber: 'C3', roomType: 'deluxe', basePrice: 1200000 },
  });
  roomId = room.id;
  const resident = await raw.resident.create({
    data: {
      tenantId,
      propertyId,
      roomId,
      fullName: 'Siti Aminah',
      nikEnc: encryptNullable('3210987654321000'),
      nikLast4: '1000',
      phone: '081288887777',
      monthlyRent: 1200000,
      checkInDate: new Date(Date.UTC(YEAR, 0, 1)),
      status: 'active',
    },
  });
  residentId = resident.id;
});

after(async () => {
  if (tenantId) await raw.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await raw.$disconnect();
});

let templateId: string;
let contractId: string;

test('(a) template create + render substitutes {vars}', async () => {
  const tpl = await asTenant(() =>
    c.createTemplate(tenantId, {
      name: 'Kontrak Standar',
      body:
        'Penyewa {nama_penyewa} (NIK {nik}) menyewa kamar {nomor_kamar} di {nama_kos}, ' +
        '{alamat}. Sewa {harga_sewa}/bulan, {tanggal_masuk} s/d {tanggal_keluar}. ' +
        'Dibuat {tanggal_hari_ini}.',
      isActive: true,
    }),
  );
  templateId = tpl.id;
  assert.equal(tpl.propertyId, null); // tenant default

  const rendered = await asTenant(() =>
    c.renderForResident(
      residentId,
      tpl.body,
      new Date(Date.UTC(YEAR, 0, 1)),
      new Date(Date.UTC(YEAR + 1, 0, 1)),
    ),
  );
  assert.ok(rendered.includes('Siti Aminah'), 'nama_penyewa substituted');
  assert.ok(rendered.includes('C3'), 'nomor_kamar substituted');
  assert.ok(rendered.includes('Kos Mawar'), 'nama_kos substituted');
  assert.ok(rendered.includes('3210987654321000'), 'nik substituted (decrypted)');
  assert.ok(rendered.includes('Rp1.200.000'), 'harga_sewa formatted + substituted');
  assert.ok(!rendered.includes('{nama_penyewa}'), 'no leftover placeholder');
});

test('(b) POST /residents/:id/contract → sequential KTR number + rendered body snapshot', async () => {
  const contract = await asTenant(() =>
    c.createContractForResident(tenantId, userId, residentId, {}),
  );
  contractId = contract.id;
  assert.equal(contract.status, 'draft');
  assert.equal(contract.contractNumber, `KTR-${YEAR}-0001`);
  assert.equal(contract.residentId, residentId);
  // Body snapshot is the rendered tenant-default template → contains the resident name + rent.
  assert.ok(contract.body.includes('Siti Aminah'), 'snapshot contains resident name');
  assert.ok(contract.body.includes('Rp1.200.000'), 'snapshot contains rendered rent');
  assert.ok(!contract.body.includes('{nama_penyewa}'), 'snapshot fully rendered');

  // A second generation → next sequential number.
  const contract2 = await asTenant(() =>
    c.createContract(tenantId, userId, {
      residentId,
      templateId,
      startDate: `${YEAR}-02-01`,
      endDate: `${YEAR + 1}-02-01`,
    }),
  );
  assert.equal(contract2.contractNumber, `KTR-${YEAR}-0002`);
});

test('(c) sign → status signed + signedAt + signature keys stored', async () => {
  const signed = await asTenant(() =>
    c.signContract(contractId, {
      residentSignatureKey: 'signatures/siti.png',
      ownerSignatureKey: 'signatures/owner.png',
    }),
  );
  assert.equal(signed.status, 'signed');
  assert.ok(signed.signedAt, 'signedAt set');
  assert.equal(signed.residentSignatureKey, 'signatures/siti.png');
  assert.equal(signed.ownerSignatureKey, 'signatures/owner.png');
});

test('(d) invalid transition (sign a terminated contract) → 409', async () => {
  // Generate a fresh contract, terminate it (draft → terminated is allowed), then sign → 409.
  const fresh = await asTenant(() =>
    c.createContract(tenantId, userId, {
      residentId,
      templateId,
      startDate: `${YEAR}-03-01`,
      endDate: `${YEAR + 1}-03-01`,
    }),
  );
  await asTenant(() => c.changeContractStatus(fresh.id, { status: 'terminated' }));
  await assert.rejects(
    () =>
      asTenant(() =>
        c.signContract(fresh.id, { residentSignatureKey: 'signatures/x.png' }),
      ),
    (e: unknown) => e instanceof AppError && e.httpStatus === 409 && e.code === 'CONFLICT',
  );
  // A status PATCH onto a terminal contract is also 409.
  await assert.rejects(
    () => asTenant(() => c.changeContractStatus(fresh.id, { status: 'active' })),
    (e: unknown) => e instanceof AppError && e.httpStatus === 409,
  );
});

test('(e) GET /contracts/:id/pdf returns a non-empty application/pdf', async () => {
  const ctx = await asTenant(() => c.getContractForPdf(contractId));
  const buffer = await generateContractPdf(ctx);
  assert.ok(buffer.length > 0, 'PDF buffer non-empty');
  assert.equal(buffer.subarray(0, 4).toString('latin1'), '%PDF', 'starts with %PDF magic');
});

test('(f) document create + documents/expiring returns a doc expiring within the window', async () => {
  // Expires in 10 days → inside a 30-day window, outside a 5-day window.
  const expires = new Date();
  expires.setUTCDate(expires.getUTCDate() + 10);
  const doc = await asTenant(() =>
    c.createDocumentForResident(tenantId, userId, residentId, {
      type: 'ktp',
      name: 'KTP Siti',
      fileKey: 'documents/siti-ktp.jpg',
      expiresAt: expires.toISOString().slice(0, 10),
    }),
  );
  assert.equal(doc.type, 'ktp');
  assert.ok(doc.expiresAt);

  const within30 = await asTenant(() =>
    c.listExpiringDocuments({ days: 30, page: 1, limit: 50 }, undefined),
  );
  assert.ok(within30.rows.some((d) => d.id === doc.id), 'doc in 30-day window');
  assert.equal(within30.windowDays, 30);

  const within5 = await asTenant(() =>
    c.listExpiringDocuments({ days: 5, page: 1, limit: 50 }, undefined),
  );
  assert.ok(!within5.rows.some((d) => d.id === doc.id), 'doc NOT in 5-day window');

  // List by resident returns the document.
  const byResident = await asTenant(() =>
    c.listDocumentsByResident(residentId, { page: 1, limit: 20, sort_order: 'desc' }),
  );
  assert.ok(byResident.rows.some((d) => d.id === doc.id));

  // Delete works.
  const del = await asTenant(() => c.deleteDocument(doc.id));
  assert.equal(del.id, doc.id);
});

test('(g) RBAC: template/sign Manager+, generate Admin+, view All (incl finance), doc delete Manager+', async () => {
  // Template config + sign + status + document delete = MANAGER_PLUS → admin denied, manager ok.
  assert.equal((await guardResult(MANAGER_PLUS, 'admin'))?.httpStatus, 403);
  assert.equal(await guardResult(MANAGER_PLUS, 'manager'), null);
  assert.equal(await guardResult(MANAGER_PLUS, 'owner'), null);
  assert.equal((await guardResult(MANAGER_PLUS, 'finance'))?.httpStatus, 403);
  // Generate contract + add document = ADMIN_PLUS → finance denied, admin ok.
  assert.equal((await guardResult(ADMIN_PLUS, 'finance'))?.httpStatus, 403);
  assert.equal(await guardResult(ADMIN_PLUS, 'admin'), null);
  // View (list/detail/pdf/templates/documents/expiring) = ALL → finance allowed.
  assert.equal(await guardResult(ALL, 'finance'), null);
});
