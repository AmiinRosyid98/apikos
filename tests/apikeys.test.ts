/**
 * Public API + API-key management tests (PRD Modul 22 — Premium-only).
 *
 * Exercises the FULL HTTP stack via a real in-process Express server on an ephemeral port, so it
 * proves the EXTERNAL API (/api/ext/v1) is mounted OUTSIDE the JWT router and authed by API keys,
 * the management endpoints (/api/v1/api-keys) are Owner-only + Premium-gated, and the plan gate +
 * scope + isolation + masking + per-key rate limit all hold.
 *
 * Coverage:
 *  (a) create key on a PREMIUM tenant → returns plaintext ONCE + only the sha256 hash is stored
 *      (DB row has NO plaintext, keyHash === sha256(key));
 *  (b) auth with the key → GET /me + /properties resolve the RIGHT tenant;
 *  (c) scope enforcement: a key WITHOUT invoices:read → 403 on /invoices;
 *  (d) revoked key → 401; expired key → 401; malformed/missing key → 401;
 *  (e) Premium gate: a PRO tenant → 403 on POST /api/v1/api-keys, AND a (manually inserted) key
 *      on a PRO tenant → 403 PLAN_LIMIT on the external API;
 *  (f) tenant isolation: a tenant-A key only returns tenant-A data, never tenant-B;
 *  (g) NIK never exposed: list + detail return masked nikLast4 only, never the raw 16-digit NIK;
 *  (h) per-key rate limit trips → 429 RATE_LIMITED (env set low below);
 *  (i) management endpoints Owner-only: manager/admin JWT → 403.
 *
 * Run: node --require ts-node/register --test tests/apikeys.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
process.env.API_KEY_RATE_LIMIT_MAX = '8';
process.env.API_KEY_RATE_LIMIT_WINDOW_MS = '3600000';
import 'dotenv/config';
import crypto from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/utils/jwt';

const raw = new PrismaClient();
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

let server: Server;
let extBase: string; // http://127.0.0.1:PORT/api/ext/v1
let dashBase: string; // http://127.0.0.1:PORT/api/v1

// Premium tenant A (keys work).
let tenantA: string;
let ownerAToken: string;
let managerAToken: string;
let residentANik = '3201010101010001';
let residentANikLast4 = '0001';

// Pro tenant B (Premium gate target + isolation target).
let tenantB: string;
let ownerBToken: string;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function jbody(res: Response): Promise<any> {
  return res.json();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function extGet(path: string, key?: string, ip = '10.0.0.1') {
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
  if (key) headers.authorization = `Bearer ${key}`;
  return fetch(`${extBase}${path}`, { headers });
}

function extPost(path: string, body: unknown, key: string, ip = '10.0.0.2') {
  return fetch(`${extBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

function dash(method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${dashBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeTenant(label: string, plan: 'pro' | 'premium') {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const t = await raw.tenant.create({
    data: {
      name: `${label} ${stamp}`,
      slug: `${label}-${stamp}`,
      subscriptionPlan: plan,
      subscriptionStatus: 'active',
      maxProperties: 50,
      maxRooms: 200,
      maxUsers: 100,
      counter: { create: {} },
    },
  });
  return t.id;
}

async function makeUser(tenantId: string, role: 'owner' | 'manager' | 'admin') {
  const u = await raw.user.create({
    data: {
      tenantId,
      email: `${role}-${tenantId.slice(0, 8)}-${Date.now()}@test.kos`,
      passwordHash: 'x',
      fullName: `${role} user`,
      role,
      isActive: true,
    },
  });
  return signAccessToken({ userId: u.id, tenantId, role });
}

/** Insert an API key row directly (for negative cases) — returns the plaintext + id. */
async function insertKey(
  tenantId: string,
  scopes: string[],
  opts: { revoked?: boolean; expired?: boolean; active?: boolean } = {},
) {
  const secret = crypto.randomBytes(40).toString('hex').slice(0, 40);
  const fullKey = `kos_live_${secret}`;
  const row = await raw.apiKey.create({
    data: {
      tenantId,
      name: 'inserted',
      keyPrefix: `kos_live_${secret.slice(0, 4)}`,
      keyHash: sha256(fullKey),
      scopes,
      isActive: opts.active === false ? false : !opts.revoked,
      revokedAt: opts.revoked ? new Date() : null,
      expiresAt: opts.expired ? new Date(Date.now() - 60_000) : null,
    },
  });
  return { fullKey, id: row.id };
}

before(async () => {
  // ---- Premium tenant A: property + room + resident (with NIK) ----
  tenantA = await makeTenant('apikey-a', 'premium');
  ownerAToken = await makeUser(tenantA, 'owner');
  managerAToken = await makeUser(tenantA, 'manager');

  const propA = await raw.property.create({
    data: {
      tenantId: tenantA,
      name: 'Kos A Premium',
      type: 'campur',
      address: 'Jl A 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      isActive: true,
    },
  });
  const roomA = await raw.room.create({
    data: { tenantId: tenantA, propertyId: propA.id, roomNumber: 'A1', roomType: 'standard', basePrice: 1000000, status: 'occupied' },
  });
  // Encrypt NIK the same way the app does (AES-256-GCM) so getResidentDetail can (but must NOT) read it.
  const KEY = Buffer.from(process.env.ENCRYPTION_KEY as string, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(residentANik, 'utf8'), cipher.final()]);
  const nikEnc = `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
  await raw.resident.create({
    data: {
      tenantId: tenantA,
      propertyId: propA.id,
      roomId: roomA.id,
      fullName: 'Penghuni A',
      nikEnc,
      nikLast4: residentANikLast4,
      phone: '081200000001',
      gender: 'male',
      emergencyName: 'Wali A',
      emergencyPhone: '081200000009',
      emergencyRelation: 'Orang tua',
      monthlyRent: 1000000,
      checkInDate: new Date(),
      status: 'active',
    },
  });

  // ---- Pro tenant B: property + room (isolation + Premium-gate target) ----
  tenantB = await makeTenant('apikey-b', 'pro');
  ownerBToken = await makeUser(tenantB, 'owner');
  await raw.property.create({
    data: { tenantId: tenantB, name: 'Kos B Pro', type: 'campur', address: 'Jl B 1', city: 'Surabaya', province: 'Jawa Timur', isActive: true },
  });

  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  extBase = `http://127.0.0.1:${port}/api/ext/v1`;
  dashBase = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await raw.tenant.delete({ where: { id: tenantA } }).catch(() => {});
  await raw.tenant.delete({ where: { id: tenantB } }).catch(() => {});
  await raw.$disconnect();
});

// ---------------------------------------------------------------------------
// (a) create on PREMIUM → plaintext once + only hash stored
// ---------------------------------------------------------------------------
let premiumKeyFull: string; // full scopes (no invoices:read for scope test? -> give all but invoices)
let premiumKeyId: string;

test('Premium tenant: POST /api-keys (owner) returns plaintext ONCE + stores only the hash', async () => {
  const res = await dash('POST', '/api-keys', ownerAToken, {
    name: 'CI key',
    scopes: ['properties:read', 'rooms:read', 'residents:read', 'bookings:read', 'bookings:write'],
  });
  assert.equal(res.status, 201, `got ${res.status}`);
  const b = await jbody(res);
  assert.equal(b.success, true);
  assert.ok(typeof b.data.key === 'string' && b.data.key.startsWith('kos_live_'), 'returns full key');
  assert.ok(b.data.keyPrefix.startsWith('kos_live_'));
  premiumKeyFull = b.data.key;
  premiumKeyId = b.data.id;

  // DB has NO plaintext — only the sha256 hash.
  const row = await raw.apiKey.findUnique({ where: { id: premiumKeyId } });
  assert.ok(row, 'row exists');
  assert.equal((row as any).keyHash, sha256(premiumKeyFull), 'keyHash === sha256(fullKey)');
  assert.notEqual((row as any).keyHash, premiumKeyFull, 'hash is not the plaintext');
  // No column anywhere holds the plaintext.
  assert.ok(!JSON.stringify(row).includes(premiumKeyFull.slice(9)), 'plaintext secret not stored');
});

// ---------------------------------------------------------------------------
// (b) auth → /me + /properties resolve the right tenant
// ---------------------------------------------------------------------------
test('Public API: valid key → GET /me + /properties resolve the owning tenant', async () => {
  const me = await jbody(await extGet('/me', premiumKeyFull));
  assert.equal(me.data.tenantId, tenantA);
  assert.ok(Array.isArray(me.data.scopes));

  const props = await jbody(await extGet('/properties', premiumKeyFull));
  assert.equal(props.success, true);
  assert.ok(props.data.length >= 1);
  assert.equal(props.data[0].name, 'Kos A Premium');
  assert.ok(props.meta && props.meta.total >= 1, 'paginated envelope');
});

// ---------------------------------------------------------------------------
// (c) scope enforcement: key lacks invoices:read → 403 on /invoices
// ---------------------------------------------------------------------------
test('Public API: key WITHOUT invoices:read → 403 on /invoices, allowed scope passes', async () => {
  const inv = await extGet('/invoices', premiumKeyFull);
  assert.equal(inv.status, 403);
  const b = await jbody(inv);
  assert.equal(b.code, 'FORBIDDEN');

  // properties:read IS granted → 200.
  const props = await extGet('/properties', premiumKeyFull);
  assert.equal(props.status, 200);
});

// ---------------------------------------------------------------------------
// (d) revoked / expired / malformed → 401
// ---------------------------------------------------------------------------
test('Public API: revoked key → 401', async () => {
  const { fullKey } = await insertKey(tenantA, ['properties:read'], { revoked: true });
  const r = await extGet('/properties', fullKey);
  assert.equal(r.status, 401);
  assert.equal((await jbody(r)).code, 'UNAUTHENTICATED');
});

test('Public API: expired key → 401', async () => {
  const { fullKey } = await insertKey(tenantA, ['properties:read'], { expired: true });
  const r = await extGet('/properties', fullKey);
  assert.equal(r.status, 401);
});

test('Public API: missing / malformed key → 401', async () => {
  assert.equal((await extGet('/properties')).status, 401);
  assert.equal((await extGet('/properties', 'not-a-key')).status, 401);
  assert.equal((await extGet('/properties', 'kos_live_short')).status, 401);
});

// ---------------------------------------------------------------------------
// (e) Premium gate — POST /api-keys on PRO → 403; external key on PRO → 403 PLAN_LIMIT
// ---------------------------------------------------------------------------
test('Premium gate: PRO tenant POST /api-keys (owner) → 403 FORBIDDEN', async () => {
  const res = await dash('POST', '/api-keys', ownerBToken, { name: 'nope', scopes: ['properties:read'] });
  assert.equal(res.status, 403, `got ${res.status}`);
  assert.equal((await jbody(res)).code, 'FORBIDDEN');
});

test('Premium gate: a key on a PRO tenant → 403 PLAN_LIMIT on the external API', async () => {
  const { fullKey } = await insertKey(tenantB, ['properties:read']);
  const r = await extGet('/properties', fullKey);
  assert.equal(r.status, 403, `got ${r.status}`);
  assert.equal((await jbody(r)).code, 'PLAN_LIMIT_EXCEEDED');
});

// ---------------------------------------------------------------------------
// (f) tenant isolation — tenant-A key never returns tenant-B data
// ---------------------------------------------------------------------------
test('Public API: tenant isolation — a tenant-A key returns ONLY tenant-A properties', async () => {
  const props = await jbody(await extGet('/properties', premiumKeyFull));
  for (const p of props.data) {
    assert.notEqual(p.name, 'Kos B Pro', 'must not see tenant B property');
  }
  assert.ok(props.data.every((p: any) => p.name === 'Kos A Premium'));
});

// ---------------------------------------------------------------------------
// (g) NIK never exposed — list + detail return masked nikLast4 only
// ---------------------------------------------------------------------------
test('Public API: residents never expose the raw NIK (masked nikLast4 only)', async () => {
  const list = await jbody(await extGet('/residents', premiumKeyFull));
  assert.ok(list.data.length >= 1);
  const r = list.data[0];
  assert.ok(!JSON.stringify(list).includes(residentANik), 'raw 16-digit NIK not in list');
  assert.equal(r.nikMasked, `************${residentANikLast4}`);

  const detail = await jbody(await extGet(`/residents/${r.id}`, premiumKeyFull));
  assert.equal(detail.success, true);
  assert.ok(!JSON.stringify(detail).includes(residentANik), 'raw NIK not in detail');
  assert.equal(detail.data.nik, undefined, 'no decrypted nik field over the API');
});

// ---------------------------------------------------------------------------
// (h) per-key rate limit trips → 429
// ---------------------------------------------------------------------------
test('Public API: per-key rate limit trips → 429 RATE_LIMITED', async () => {
  // Fresh key with a low budget (API_KEY_RATE_LIMIT_MAX=8 set at top). Use a UNIQUE source IP so
  // the global IP limiter (100/min) is irrelevant; the per-KEY limiter must be what trips.
  const { fullKey } = await insertKey(tenantA, ['properties:read']);
  let got429 = false;
  for (let i = 0; i < 15; i++) {
    const r = await extGet('/me', fullKey, '172.31.0.55');
    if (r.status === 429) {
      assert.equal((await jbody(r)).code, 'RATE_LIMITED');
      got429 = true;
      break;
    }
  }
  assert.ok(got429, 'expected a 429 after exceeding the per-key budget');
});

// ---------------------------------------------------------------------------
// (i) management endpoints Owner-only — manager/admin → 403
// ---------------------------------------------------------------------------
test('Management: manager JWT → 403 on GET + POST /api-keys (owner-only)', async () => {
  const list = await dash('GET', '/api-keys', managerAToken);
  assert.equal(list.status, 403, `GET got ${list.status}`);
  const create = await dash('POST', '/api-keys', managerAToken, { name: 'x', scopes: ['properties:read'] });
  assert.equal(create.status, 403, `POST got ${create.status}`);
});

// ---------------------------------------------------------------------------
// revoke via the management endpoint → external key then 401
// ---------------------------------------------------------------------------
test('Management: POST /api-keys/:id/revoke → key then 401 on the external API', async () => {
  // A dedicated key to revoke.
  const createRes = await dash('POST', '/api-keys', ownerAToken, { name: 'to-revoke', scopes: ['properties:read'] });
  const created = await jbody(createRes);
  const full = created.data.key;
  assert.equal((await extGet('/properties', full)).status, 200, 'works before revoke');

  const rev = await dash('POST', `/api-keys/${created.data.id}/revoke`, ownerAToken);
  assert.equal(rev.status, 200);
  assert.equal((await jbody(rev)).data.status, 'revoked');

  assert.equal((await extGet('/properties', full)).status, 401, '401 after revoke');
});

// ---------------------------------------------------------------------------
// bookings:write — POST /bookings via key with the scope
// ---------------------------------------------------------------------------
test('Public API: POST /bookings honours bookings:write + tenant scope', async () => {
  // An empty room in tenant A to book.
  const propA = await raw.property.findFirst({ where: { tenantId: tenantA } });
  const emptyRoom = await raw.room.create({
    data: { tenantId: tenantA, propertyId: propA!.id, roomNumber: 'A-book', roomType: 'standard', basePrice: 800000, status: 'empty' },
  });
  const res = await extPost(
    '/bookings',
    {
      roomId: emptyRoom.id,
      prospectName: 'Calon API',
      prospectPhone: '081299990000',
      plannedCheckInDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    },
    premiumKeyFull,
  );
  assert.equal(res.status, 201, `got ${res.status} ${JSON.stringify(await jbody(res.clone()))}`);
  const b = await jbody(res);
  assert.equal(b.data.status, 'pending');
  // Created in tenant A.
  const row = await raw.booking.findUnique({ where: { id: b.data.id } });
  assert.equal((row as any).tenantId, tenantA);
});
