/**
 * Web Push module tests (PLAN_WEB_PUSH.md / PRD §6.18 web-push seam). Proves the push subscription
 * lifecycle + the notify() fan-out seam + failure isolation + stale-subscription pruning, WITHOUT
 * hitting any real push service.
 *
 * Cases:
 *  (a) subscribe: first call creates a row; a SECOND subscribe with the SAME endpoint UPSERTS
 *      (no duplicate row; lastUsedAt touched; keys/userAgent refreshed).
 *  (b) unsubscribe: removes the caller's subscription by endpoint; a second call is idempotent
 *      (still { removed: true }, no throw).
 *  (c) public-key: returns the configured VAPID key (string, non-empty) and does NOT throw/500.
 *  (d) test push: with a stored subscription the mocked transport is invoked; with none returns
 *      { sent: 0, subscriptions: 0 }.
 *  (e) notify() seam: notify() for a user WHO HAS a subscription triggers webpush.sendToUser →
 *      web-push.sendNotification (mocked). A pref-disabled recipient gets NEITHER in-app NOR push.
 *  (f) failure isolation: when the mocked transport REJECTS, notify() still resolves (never throws).
 *  (g) stale pruning: a 410 (or 404) statusCode from the transport DELETES the subscription row.
 *  (h) tenant scoping: a subscription in tenant A is never targeted by a notify() in tenant B.
 *
 * THE TRANSPORT IS FULLY MOCKED: we replace `web-push`'s `sendNotification` + `setVapidDetails` on
 * the cached module singleton, so no network calls ever happen. VAPID env is set BEFORE any app
 * module loads so `webPushConfigured` is true (the "enabled" path is exercised).
 *
 * Run: node --require ts-node/register --test tests/push.test.ts
 */
/// <reference path="../src/types/express.d.ts" />
import 'dotenv/config';

// ── 1) Force VAPID env ON *before* importing any app module (env.ts captures webPushConfigured at
//        import time). A real generated keypair so setVapidDetails() does not reject. ───────────────
process.env.VAPID_PUBLIC_KEY =
  'BIIRtHilrWcTKF_tLe6HSVIQoFpuI8-vibjhWt1i-ceURcmeARR6Q7Czukk9AQNo5TU21k8wsV8doWDG4ppiw8E';
process.env.VAPID_PRIVATE_KEY = 'vXbCLaG0t4gkdim2YAirG2zmuZMV1EDX_rXqtZgtTSU';
process.env.VAPID_SUBJECT = 'mailto:programmer.prahu@gmail.com';

// ── 2) Mock the `web-push` transport singleton (same object the service imports). ─────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpushPkg = require('web-push') as {
  sendNotification: (...a: unknown[]) => Promise<unknown>;
  setVapidDetails: (...a: unknown[]) => void;
};

interface SendCall {
  endpoint: string;
  payload: unknown;
}
let sendCalls: SendCall[] = [];
// Behaviour the mock should apply on the NEXT call(s): 'ok' | 'reject' | a statusCode to throw.
let sendMode: 'ok' | 'reject' | number = 'ok';

webpushPkg.setVapidDetails = () => {
  /* no-op in tests; real signing not needed */
};
webpushPkg.sendNotification = async (sub: unknown, payload: unknown) => {
  const endpoint = (sub as { endpoint: string }).endpoint;
  sendCalls.push({
    endpoint,
    payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
  });
  if (sendMode === 'reject') {
    throw new Error('mock transport network failure');
  }
  if (typeof sendMode === 'number') {
    const err = new Error(`mock push gone (status ${sendMode})`) as Error & { statusCode: number };
    err.statusCode = sendMode;
    throw err;
  }
  return { statusCode: 201 };
};

// ── 3) NOW import the app modules (they pick up the env + the mocked transport). ──────────────────
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/config/tenantStore';
import { webPushConfigured } from '../src/config/env';
import { notify } from '../src/services/notification.service';
import * as pushSvc from '../src/modules/push/push.service';

const raw = new PrismaClient();

let tenantId: string;
let tenantBId: string;
const users: Record<string, string> = {}; // role → userId (tenant A)
let userBId: string; // an owner in tenant B

function asTenant<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId, userId: users.owner }, fn);
}
function asTenantB<T>(fn: () => Promise<T>) {
  return runWithTenant({ tenantId: tenantBId, userId: userBId }, fn);
}

/**
 * The notify() web-push fan-out is fire-and-forget (`void webpush.sendToUser(...)`), so it resolves
 * AFTER notify() returns — and it performs multiple DB round-trips (findMany → sendNotification →
 * updateMany). Poll until the expected transport call(s) land instead of using a fixed sleep, so the
 * assertions are not flaky on a slow DB. Resolves early on the predicate, else after `timeoutMs`.
 */
async function waitForPush(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

const SUB = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/push-test-${n}`,
  keys: { p256dh: `p256dh-key-${n}`, auth: `auth-secret-${n}` },
  userAgent: 'Mozilla/5.0 (Test)',
});

before(async () => {
  const stamp = Date.now();
  const tenant = await raw.tenant.create({
    data: {
      name: `PushPro ${stamp}`,
      slug: `push-pro-${stamp}`,
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
        email: `${role}-${stamp}@push.kos`,
        passwordHash: 'x',
        fullName: `Push ${role}`,
        role,
        isActive: true,
      },
    });
    users[role] = u.id;
  }

  const tenantB = await raw.tenant.create({
    data: {
      name: `PushProB ${stamp}`,
      slug: `push-pro-b-${stamp}`,
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
  tenantBId = tenantB.id;
  const ownerB = await raw.user.create({
    data: {
      tenantId: tenantBId,
      email: `owner-b-${stamp}@push.kos`,
      passwordHash: 'x',
      fullName: 'Push owner B',
      role: 'owner',
      isActive: true,
    },
  });
  userBId = ownerB.id;
});

after(async () => {
  if (tenantId) await raw.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  if (tenantBId) await raw.tenant.delete({ where: { id: tenantBId } }).catch(() => {});
  await raw.$disconnect();
});

beforeEach(() => {
  sendCalls = [];
  sendMode = 'ok';
});

test('VAPID env is configured for the test process (enabled path)', () => {
  assert.equal(webPushConfigured, true, 'webPushConfigured must be true so the enabled path runs');
});

test('(a) subscribe: creates a row; SAME endpoint upserts (no duplicate, lastUsedAt touched)', async () => {
  const input = SUB(1);
  const first = await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, input));
  assert.ok(first.id, 'returns an id');
  assert.equal(first.endpoint, input.endpoint);
  assert.ok(first.createdAt, 'returns createdAt');

  const rowsAfterFirst = await raw.pushSubscription.count({ where: { endpoint: input.endpoint } });
  assert.equal(rowsAfterFirst, 1, 'exactly one row after first subscribe');

  // Second subscribe with the SAME endpoint but refreshed keys → UPSERT (no duplicate).
  const input2 = {
    ...input,
    keys: { p256dh: 'p256dh-refreshed', auth: 'auth-refreshed' },
    userAgent: 'Mozilla/5.0 (Refreshed)',
  };
  const second = await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, input2));
  assert.equal(second.id, first.id, 'same row id (upsert, not a new row)');

  const rowsAfterSecond = await raw.pushSubscription.count({ where: { endpoint: input.endpoint } });
  assert.equal(rowsAfterSecond, 1, 'still exactly one row after re-subscribe (no duplicate)');

  const row = await raw.pushSubscription.findUnique({ where: { endpoint: input.endpoint } });
  assert.equal(row?.p256dh, 'p256dh-refreshed', 'keys refreshed on upsert');
  assert.equal(row?.auth, 'auth-refreshed');
  assert.equal(row?.userAgent, 'Mozilla/5.0 (Refreshed)');
  assert.ok(row?.lastUsedAt, 'lastUsedAt touched on update');

  // cleanup
  await raw.pushSubscription.deleteMany({ where: { endpoint: input.endpoint } });
});

test('(b) unsubscribe: removes by endpoint; second call is idempotent (still removed:true)', async () => {
  const input = SUB(2);
  await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, input));
  assert.equal(await raw.pushSubscription.count({ where: { endpoint: input.endpoint } }), 1);

  const r1 = await asTenant(() => pushSvc.removeSubscription(users.owner, input.endpoint));
  assert.deepEqual(r1, { removed: true });
  assert.equal(
    await raw.pushSubscription.count({ where: { endpoint: input.endpoint } }),
    0,
    'row removed',
  );

  // Idempotent: removing again still returns removed:true and does not throw.
  const r2 = await asTenant(() => pushSvc.removeSubscription(users.owner, input.endpoint));
  assert.deepEqual(r2, { removed: true }, 'idempotent unsubscribe');
});

test('(c) public-key: returns the configured key, does NOT throw / 500', () => {
  const result = pushSvc.getPublicKey();
  assert.equal(typeof result.publicKey, 'string', 'configured → returns a string key');
  assert.ok((result.publicKey as string).length > 0, 'key is non-empty');
  assert.equal(result.publicKey, process.env.VAPID_PUBLIC_KEY, 'echoes the configured VAPID key');
  // (The null branch — VAPID absent — is the same guarded getter (`webPushConfigured ? key : null`),
  //  so it returns { publicKey: null } and never throws; see QA_REPORT for the env caveat.)
});

test('(d) test push: invokes the transport for a stored sub; none → { sent:0, subscriptions:0 }', async () => {
  // No subscriptions yet for finance → 0/0, transport NOT called.
  const empty = await asTenant(() => pushSvc.sendTestToUser(users.finance));
  assert.deepEqual(empty, { sent: 0, subscriptions: 0 });
  assert.equal(sendCalls.length, 0, 'no transport call when the user has no subscriptions');

  // Store a subscription for the owner, then test push.
  const input = SUB(3);
  await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, input));
  const res = await asTenant(() => pushSvc.sendTestToUser(users.owner));
  assert.equal(res.subscriptions, 1, 'reports the count the user has');
  assert.equal(res.sent, 1, 'one push succeeded');
  assert.equal(sendCalls.length, 1, 'the mocked transport was invoked exactly once');
  assert.equal(sendCalls[0].endpoint, input.endpoint);
  assert.equal((sendCalls[0].payload as { title: string }).title, 'Notifikasi uji KosManager');

  await raw.pushSubscription.deleteMany({ where: { endpoint: input.endpoint } });
});

test('(e) notify() seam: pushes to a subscribed recipient; pref-OFF user gets NO in-app AND NO push', async () => {
  // Owner + manager both subscribe.
  const ownerSub = SUB(10);
  const managerSub = SUB(11);
  await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, ownerSub));
  await asTenant(() => pushSvc.upsertSubscription(users.manager, tenantId, managerSub));

  // Manager opts OUT of booking_new.
  await asTenant(() =>
    raw.user.update({
      where: { id: users.manager },
      data: { notificationPrefs: { booking_new: false } },
    }),
  );

  const created = await asTenant(() =>
    notify({
      tenantId,
      type: 'booking_new', // default roles: owner/manager/admin
      title: 'Booking baru',
      body: 'Ada pemesanan kamar',
      link: '/bookings/123',
    }),
  );

  // owner + admin get in-app rows; manager opted out. admin has no subscription so no push for them.
  assert.equal(created, 2, 'owner + admin get in-app rows; manager opted out');

  // Push fan-out is fire-and-forget (void). Poll until the owner's push lands.
  await waitForPush(() => sendCalls.some((c) => c.endpoint === ownerSub.endpoint));

  const endpointsCalled = sendCalls.map((c) => c.endpoint);
  assert.ok(endpointsCalled.includes(ownerSub.endpoint), 'owner (subscribed, pref-on) got a push');
  assert.ok(
    !endpointsCalled.includes(managerSub.endpoint),
    'manager opted out → NO push (and no in-app row)',
  );
  // admin is a recipient but has no subscription → no push call for admin (and we never created one).
  assert.equal(sendCalls.length, 1, 'exactly one push (only the subscribed, pref-on owner)');
  const payload = sendCalls[0].payload as { title: string; body: string; url: string; type: string };
  assert.equal(payload.title, 'Booking baru');
  assert.equal(payload.url, '/bookings/123', 'link is forwarded as url');
  assert.equal(payload.type, 'booking_new');

  // reset manager prefs + subs for later tests
  await asTenant(() =>
    raw.user.update({ where: { id: users.manager }, data: { notificationPrefs: {} } }),
  );
  await raw.pushSubscription.deleteMany({
    where: { endpoint: { in: [ownerSub.endpoint, managerSub.endpoint] } },
  });
});

test('(f) failure isolation: transport REJECTS → notify() still resolves (never throws)', async () => {
  const ownerSub = SUB(20);
  await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, ownerSub));
  sendMode = 'reject';

  let created = -1;
  await assert.doesNotReject(async () => {
    created = await asTenant(() =>
      notify({ tenantId, type: 'general', title: 'X', body: 'Y' }),
    );
  }, 'notify() must never throw even when the transport rejects');
  assert.ok(created >= 1, 'in-app rows were still written despite the transport failure');

  await waitForPush(() => sendCalls.some((c) => c.endpoint === ownerSub.endpoint));
  assert.ok(
    sendCalls.some((c) => c.endpoint === ownerSub.endpoint),
    'the transport was attempted (and its rejection swallowed)',
  );
  // The row is NOT pruned on a generic (non-404/410) failure.
  assert.equal(
    await raw.pushSubscription.count({ where: { endpoint: ownerSub.endpoint } }),
    1,
    'a generic transport error does NOT prune the subscription',
  );

  await raw.pushSubscription.deleteMany({ where: { endpoint: ownerSub.endpoint } });
});

test('(g) stale pruning: a 410 (and 404) from the transport DELETES the subscription row', async () => {
  // 410 Gone
  const gone = SUB(30);
  await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, gone));
  sendMode = 410;
  await asTenant(() => pushSvc.sendTestToUser(users.owner));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    await raw.pushSubscription.count({ where: { endpoint: gone.endpoint } }),
    0,
    '410 → stale subscription pruned',
  );

  // 404 Not Found
  const missing = SUB(31);
  await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, missing));
  sendMode = 404;
  await asTenant(() => pushSvc.sendTestToUser(users.owner));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    await raw.pushSubscription.count({ where: { endpoint: missing.endpoint } }),
    0,
    '404 → stale subscription pruned',
  );
});

test('(h) tenant scoping: a subscription in tenant A is NOT targeted by a notify() in tenant B', async () => {
  // Owner A subscribes (tenant A).
  const ownerASub = SUB(40);
  await asTenant(() => pushSvc.upsertSubscription(users.owner, tenantId, ownerASub));

  // notify() runs inside tenant B's context. Recipients resolve from tenant B users only.
  await asTenantB(() =>
    notify({ tenantId: tenantBId, type: 'general', title: 'B-only', body: 'tenant B' }),
  );
  // Settle the fire-and-forget fan-out, then assert tenant A's endpoint was never touched.
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(
    !sendCalls.some((c) => c.endpoint === ownerASub.endpoint),
    "tenant B's notify must never push to tenant A's subscription",
  );

  await raw.pushSubscription.deleteMany({ where: { endpoint: ownerASub.endpoint } });
});
