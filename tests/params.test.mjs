import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, login, cleanupTenants } from './helpers.mjs';

// BUG-004 regression: a malformed (non-UUID) `:id` / `:depId` path param must
// return 422 VALIDATION_ERROR with the standard envelope — never a 500
// INTERNAL_ERROR (which, in non-prod, leaked the Prisma query + source path).
// A well-formed-but-nonexistent UUID must still behave as before → 404 NOT_FOUND.

after(async () => {
  await cleanupTenants();
});

const BAD = 'not-a-uuid';
const MISSING = '00000000-0000-4000-8000-000000000000'; // well-formed v4, certainly absent

function assertValidationEnvelope(r, label) {
  assert.equal(r.status, 422, `${label}: expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.success, false, `${label}: success must be false`);
  assert.equal(r.body.code, 'VALIDATION_ERROR', `${label}: code must be VALIDATION_ERROR`);
  assert.ok(typeof r.body.message === 'string' && r.body.message.length, `${label}: message present`);
  assert.ok(Array.isArray(r.body.errors) && r.body.errors.length, `${label}: errors[] present`);
  // No leak: no Prisma invocation / absolute source path in the response.
  const blob = JSON.stringify(r.body);
  assert.ok(!/prisma\./i.test(blob), `${label}: must not leak a Prisma invocation`);
  assert.ok(!/\.service\.ts/i.test(blob), `${label}: must not leak a source path`);
  assert.ok(!('detail' in r.body), `${label}: must not include a detail leak`);
}

// Representative set of id-based GET endpoints across modules.
const GET_ENDPOINTS = [
  ['GET /properties/:id', (id) => `/properties/${id}`],
  ['GET /rooms/:id', (id) => `/rooms/${id}`],
  ['GET /residents/:id', (id) => `/residents/${id}`],
  ['GET /invoices/:id', (id) => `/invoices/${id}`],
  ['GET /handovers/:id', (id) => `/handovers/${id}`],
  ['GET /users/:id', (id) => `/users/${id}`],
];

for (const [label, path] of GET_ENDPOINTS) {
  test(`BUG-004: malformed :id on ${label} → 422 (not 500, no leak)`, async () => {
    const token = await login('owner');
    const r = await get(path(BAD), { token });
    assertValidationEnvelope(r, label);
  });

  test(`BUG-004: valid-but-missing UUID on ${label} → 404 NOT_FOUND`, async () => {
    const token = await login('owner');
    const r = await get(path(MISSING), { token });
    assert.equal(r.status, 404, `${label}: expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'NOT_FOUND', `${label}: code must be NOT_FOUND`);
  });
}

// Mutating id-based route: PATCH /bookings/:id/confirm.
test('BUG-004: malformed :id on PATCH /bookings/:id/confirm → 422 (not 500)', async () => {
  const token = await login('manager');
  const r = await patch(`/bookings/${BAD}/confirm`, {}, { token });
  assertValidationEnvelope(r, 'PATCH /bookings/:id/confirm');
});

// Nested param: malformed :depId on POST /residents/:id/deposits/:depId/refund.
// :id is a valid (seeded) resident so the failure is isolated to :depId.
test('BUG-004: malformed :depId on POST /residents/:id/deposits/:depId/refund → 422', async () => {
  const owner = await login('owner');
  const manager = await login('manager');
  const residents = await get('/residents', { token: owner });
  const residentId = residents.body.data[0]?.id;
  assert.ok(residentId, 'seeded demo resident present');
  const r = await post(`/residents/${residentId}/deposits/${BAD}/refund`, {
    refundedAmount: 0, deductionAmount: 0,
  }, { token: manager });
  assertValidationEnvelope(r, 'POST /residents/:id/deposits/:depId/refund');
});
