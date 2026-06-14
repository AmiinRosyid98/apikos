/**
 * White-label Branding tests (PRD Modul 23 — Premium). Exercises the FULL HTTP stack via a real
 * Express server on an ephemeral port so it proves the route guards (authGuard, tenantContext,
 * rbacGuard OWNER_ONLY) AND the service-layer Premium gate fire together, plus the public-landing
 * branding behaviour (unauthenticated).
 *
 * Coverage:
 *  (a) GET /branding (unset) → defaults { brandName = tenant.name, brandColor: null, logoUrl: null };
 *  (b) PUT /branding on a PREMIUM tenant (owner) → sets brandName + brandColor;
 *  (c) PUT invalid brandColor hex → 422 VALIDATION_ERROR;
 *  (d) Premium gate: PUT on a PRO tenant → 403; on a BASIC tenant → 403;
 *  (e) RBAC: PUT as manager → 403, as admin → 403; as owner → ok;
 *  (f) GET reflects the update;
 *  (g) public landing for a PREMIUM tenant INCLUDES branding; a PRO tenant's landing does NOT;
 *  (h) logo clear: PUT { logoKey: null } → logoUrl null; setting an unknown logoKey → 422.
 *
 * Run: node --require ts-node/register --test tests/branding.test.ts   (npm run test:branding)
 * Creates + tears down its own isolated tenants.
 */
/// <reference path="../src/types/express.d.ts" />
process.env.PUBLIC_READ_RATE_LIMIT_MAX = '500';
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { signAccessToken, type JwtRole } from '../src/utils/jwt';
import { disconnectPublic } from '../src/modules/public/public.service';

const raw = new PrismaClient();

let server: Server;
let baseUrl: string;

interface Fixture {
  tenantId: string;
  ownerToken: string;
  managerToken: string;
  adminToken: string;
  slug: string;
}

const fixtures: Record<'premium' | 'pro' | 'basic', Fixture> = {} as never;

async function mkUser(tenantId: string, role: JwtRole): Promise<string> {
  const u = await raw.user.create({
    data: {
      tenantId,
      email: `${role}-${randomUUID()}@brand.test`,
      passwordHash: 'x',
      fullName: `${role} user`,
      role,
      isActive: true,
    },
  });
  return signAccessToken({ userId: u.id, tenantId, role });
}

async function makeFixture(plan: 'premium' | 'pro' | 'basic'): Promise<Fixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const slug = `brand-${plan}-${stamp}`;
  const t = await raw.tenant.create({
    data: {
      name: `Brand ${plan} ${stamp}`,
      slug: `brand-${plan}-t-${stamp}`,
      subscriptionPlan: plan,
      subscriptionStatus: 'active',
      maxProperties: 50,
      maxRooms: 100,
      maxUsers: 50,
      counter: { create: {} },
    },
  });
  // A public-enabled property so the landing resolves by slug.
  await raw.property.create({
    data: {
      tenantId: t.id,
      name: `Kos ${plan}`,
      type: 'campur',
      address: 'Jl Brand 1',
      city: 'Jakarta',
      province: 'DKI',
      facilities: ['wifi'],
      publicSlug: slug,
      publicEnabled: true,
      isActive: true,
    },
  });
  return {
    tenantId: t.id,
    ownerToken: await mkUser(t.id, 'owner'),
    managerToken: await mkUser(t.id, 'manager'),
    adminToken: await mkUser(t.id, 'admin'),
    slug,
  };
}

function authedPut(token: string, body: unknown) {
  return fetch(`${baseUrl}/branding`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
function authedGet(token: string) {
  return fetch(`${baseUrl}/branding`, { headers: { authorization: `Bearer ${token}` } });
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
  await disconnectPublic();
  await raw.$disconnect();
});

test('(a) GET /branding unset → defaults (brandName=tenant.name, color/logo null)', async () => {
  const res = await authedGet(fixtures.premium.ownerToken);
  assert.equal(res.status, 200);
  const json = await body(res);
  assert.equal(json.success, true);
  assert.ok(json.data.brandName.startsWith('Brand premium'), 'defaults to tenant.name');
  assert.equal(json.data.brandColor, null);
  assert.equal(json.data.logoUrl, null);
});

test('(b) PUT /branding on PREMIUM (owner) → sets brandName + brandColor', async () => {
  const res = await authedPut(fixtures.premium.ownerToken, {
    brandName: 'Kos Mewah',
    brandColor: '#1A2B3C',
  });
  assert.equal(res.status, 200);
  const json = await body(res);
  assert.equal(json.data.brandName, 'Kos Mewah');
  assert.equal(json.data.brandColor, '#1A2B3C');
});

test('(c) PUT invalid brandColor hex → 422 VALIDATION_ERROR', async () => {
  for (const bad of ['1A2B3C', '#12345', '#GGGGGG', 'red']) {
    const res = await authedPut(fixtures.premium.ownerToken, { brandColor: bad });
    assert.equal(res.status, 422, `"${bad}" should be rejected`);
    const json = await body(res);
    assert.equal(json.code, 'VALIDATION_ERROR');
  }
});

test('(d) Premium gate: PUT on PRO → 403, on BASIC → 403', async () => {
  for (const plan of ['pro', 'basic'] as const) {
    const res = await authedPut(fixtures[plan].ownerToken, { brandName: 'Nope' });
    assert.equal(res.status, 403, `${plan} owner PUT must be 403`);
    const json = await body(res);
    assert.equal(json.code, 'FORBIDDEN');
    // The branding was NOT persisted.
    const t = await raw.tenant.findUnique({ where: { id: fixtures[plan].tenantId } });
    assert.equal(t!.brandName, null);
  }
});

test('(e) RBAC: PUT as manager → 403, as admin → 403 (Premium tenant, owner ok)', async () => {
  const mgr = await authedPut(fixtures.premium.managerToken, { brandName: 'Hijack' });
  assert.equal(mgr.status, 403);
  assert.equal((await body(mgr)).code, 'FORBIDDEN');

  const adm = await authedPut(fixtures.premium.adminToken, { brandName: 'Hijack' });
  assert.equal(adm.status, 403);
  assert.equal((await body(adm)).code, 'FORBIDDEN');

  // Owner still works.
  const own = await authedPut(fixtures.premium.ownerToken, { brandColor: '#FF8800' });
  assert.equal(own.status, 200);
  assert.equal((await body(own)).data.brandColor, '#FF8800');
});

test('(f) GET reflects the update', async () => {
  const res = await authedGet(fixtures.premium.managerToken); // any role can GET
  assert.equal(res.status, 200);
  const json = await body(res);
  assert.equal(json.data.brandName, 'Kos Mewah');
  assert.equal(json.data.brandColor, '#FF8800');
});

test('(g) public landing: PREMIUM includes branding; PRO does not', async () => {
  const premRes = await fetch(`${baseUrl}/public/properties/${fixtures.premium.slug}`);
  assert.equal(premRes.status, 200);
  const prem = await body(premRes);
  assert.ok(prem.data.branding, 'premium landing includes branding');
  assert.equal(prem.data.branding.brandName, 'Kos Mewah');
  assert.equal(prem.data.branding.brandColor, '#FF8800');
  // Marketing-safe: no plan/ids leak in the branding payload.
  const blob = JSON.stringify(prem.data.branding);
  for (const leak of ['tenantId', 'subscriptionPlan', 'logoKey']) {
    assert.equal(blob.includes(leak), false, `branding must not leak "${leak}"`);
  }

  const proRes = await fetch(`${baseUrl}/public/properties/${fixtures.pro.slug}`);
  assert.equal(proRes.status, 200);
  const pro = await body(proRes);
  assert.equal(pro.data.branding, null, 'pro landing has no branding (stays default)');
});

test('(h) logo: unknown logoKey → 422; clearing with null → logoUrl null', async () => {
  // Unknown key (not a tracked `logo` file) → 422.
  const bad = await authedPut(fixtures.premium.ownerToken, { logoKey: 'tenants/x/logo/nope.png' });
  assert.equal(bad.status, 422);
  assert.equal((await body(bad)).code, 'VALIDATION_ERROR');

  // Set a real logo file (tracked), then clear it.
  const key = `tenants/${fixtures.premium.tenantId}/logo/${randomUUID()}.png`;
  await raw.fileObject.create({
    data: {
      tenantId: fixtures.premium.tenantId,
      key,
      purpose: 'logo',
      contentType: 'image/png',
      sizeBytes: 1234,
      uploadedBy: randomUUID(),
      isPrivate: false,
    },
  });
  const set = await authedPut(fixtures.premium.ownerToken, { logoKey: key });
  assert.equal(set.status, 200);
  // logoUrl is a STUB placeholder URL (R2 not wired) — present + non-null when a key is set.
  assert.notEqual((await body(set)).data.logoUrl, null, 'logoUrl resolved for a tracked key');

  const cleared = await authedPut(fixtures.premium.ownerToken, { logoKey: null });
  assert.equal(cleared.status, 200);
  assert.equal((await body(cleared)).data.logoUrl, null, 'logoUrl null after clear');
});
