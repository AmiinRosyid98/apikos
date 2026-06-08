import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, put, login } from './helpers.mjs';

// Helpers to fetch seeded property + resident + room + invoice ids for action tests.
async function ctx() {
  const owner = await login('owner');
  const props = await get('/properties', { token: owner, query: { limit: 100 } });
  // Pick a property that actually has at least one room (the seeded "Kos Melati"),
  // since other tests may add room-less properties to the demo tenant.
  let propertyId = props.body.data[0].id;
  let roomId;
  for (const p of props.body.data) {
    const rooms = await get(`/properties/${p.id}/rooms`, { token: owner });
    if (rooms.body.data && rooms.body.data.length) {
      propertyId = p.id;
      roomId = rooms.body.data[0].id;
      break;
    }
  }
  const residents = await get('/residents', { token: owner });
  const residentId = residents.body.data[0]?.id;
  const invoices = await get('/invoices', { token: owner });
  const invoiceId = invoices.body.data[0]?.id;
  return { owner, propertyId, roomId, residentId, invoiceId };
}

// ---- Property add: Owner only ----
test('RBAC: admin POST /properties → 403', async () => {
  const token = await login('admin');
  const r = await post('/properties', {
    name: 'X', type: 'campur', address: 'a', city: 'c', province: 'p',
  }, { token });
  assert.equal(r.status, 403, `got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'FORBIDDEN');
});

test('RBAC: manager POST /properties → 403 (owner-only add)', async () => {
  const token = await login('manager');
  const r = await post('/properties', {
    name: 'X', type: 'campur', address: 'a', city: 'c', province: 'p',
  }, { token });
  assert.equal(r.status, 403);
});

test('RBAC: finance POST /properties → 403', async () => {
  const token = await login('finance');
  const r = await post('/properties', {
    name: 'X', type: 'campur', address: 'a', city: 'c', province: 'p',
  }, { token });
  assert.equal(r.status, 403);
});

// ---- Property edit: Owner + Manager ----
test('RBAC: manager PUT /properties/:id allowed (2xx)', async () => {
  const { propertyId } = await ctx();
  const token = await login('manager');
  const cur = await get(`/properties/${propertyId}`, { token });
  const p = cur.body.data;
  const r = await put(`/properties/${propertyId}`, {
    name: p.name, type: p.type, address: p.address, city: p.city, province: p.province,
    billingDay: p.billingDay ?? 1,
  }, { token });
  assert.ok(r.status >= 200 && r.status < 300, `manager edit should be allowed, got ${r.status} ${JSON.stringify(r.body)}`);
});

test('RBAC: admin PUT /properties/:id → 403 (admin cannot edit property)', async () => {
  const { propertyId } = await ctx();
  const token = await login('admin');
  const r = await put(`/properties/${propertyId}`, {
    name: 'Z', type: 'campur', address: 'a', city: 'c', province: 'p',
  }, { token });
  assert.equal(r.status, 403, `got ${r.status} ${JSON.stringify(r.body)}`);
});

// ---- Resident create: Admin+ (owner/manager/admin), finance denied ----
test('RBAC: finance POST /residents → 403', async () => {
  const { propertyId, roomId } = await ctx();
  const token = await login('finance');
  const r = await post('/residents', {
    propertyId, roomId, fullName: 'Test', phone: '0812', checkInDate: '2026-06-01',
    contractEndDate: '2027-06-01', monthlyRent: 800000,
  }, { token });
  assert.equal(r.status, 403, `got ${r.status} ${JSON.stringify(r.body)}`);
});

// ---- Room bulk-price: Owner+Manager only (admin denied) ----
test('RBAC: admin POST bulk-price → 403', async () => {
  const { propertyId } = await ctx();
  const token = await login('admin');
  const r = await post(`/properties/${propertyId}/rooms/bulk-price`, {
    filter: {}, adjustType: 'percent', value: 0,
  }, { token });
  assert.equal(r.status, 403, `got ${r.status} ${JSON.stringify(r.body)}`);
});

test('RBAC: admin POST room (create) allowed (Admin+)', async () => {
  const { propertyId } = await ctx();
  const token = await login('admin');
  const r = await post(`/properties/${propertyId}/rooms`, {
    roomNumber: 'QA-' + Date.now(), roomType: 'standard', basePrice: 500000,
  }, { token });
  assert.ok(r.status >= 200 && r.status < 300, `admin room create should be allowed, got ${r.status} ${JSON.stringify(r.body)}`);
});

// ---- Invoice generate: Admin+ ; finance denied ----
test('RBAC: finance POST /invoices/generate → 403', async () => {
  const { propertyId } = await ctx();
  const token = await login('finance');
  const r = await post('/invoices/generate', {
    propertyId, periodMonth: 6, periodYear: 2026,
  }, { token });
  assert.equal(r.status, 403, `got ${r.status} ${JSON.stringify(r.body)}`);
});

// ---- Invoice mark-paid: Finance+ allowed; admin denied ----
test('RBAC: admin POST /invoices/:id/mark-paid → 403', async () => {
  const { invoiceId } = await ctx();
  if (!invoiceId) return; // no invoice seeded
  const token = await login('admin');
  const r = await post(`/invoices/${invoiceId}/mark-paid`, { method: 'cash' }, { token });
  assert.equal(r.status, 403, `admin should be denied mark-paid, got ${r.status} ${JSON.stringify(r.body)}`);
});

// ---- Users invite: Owner only ----
test('RBAC: manager POST /users/invite → 403', async () => {
  const token = await login('manager');
  const r = await post('/users/invite', {
    email: 'inv.' + Date.now() + '@qa.kos', fullName: 'Inv', role: 'admin', propertyIds: [],
  }, { token });
  assert.equal(r.status, 403, `got ${r.status} ${JSON.stringify(r.body)}`);
});

test('RBAC: finance GET /users allowed (team list view = All)', async () => {
  const token = await login('finance');
  const r = await get('/users', { token });
  assert.equal(r.status, 200, `finance should view team list, got ${r.status}`);
});

// ---- Subscription change-plan: Owner only ----
test('RBAC: manager POST /subscription/change-plan → 403', async () => {
  const token = await login('manager');
  const r = await post('/subscription/change-plan', { plan: 'pro' }, { token });
  assert.equal(r.status, 403, `got ${r.status} ${JSON.stringify(r.body)}`);
});

// ---- Audit log: Owner full, Manager view, Admin/Finance denied ----
test('RBAC: owner GET /audit-logs allowed', async () => {
  const token = await login('owner');
  const r = await get('/audit-logs', { token });
  assert.equal(r.status, 200);
});

test('RBAC: manager GET /audit-logs allowed (view-only)', async () => {
  const token = await login('manager');
  const r = await get('/audit-logs', { token });
  assert.equal(r.status, 200, `manager should view audit, got ${r.status}`);
});

test('RBAC: admin GET /audit-logs → 403', async () => {
  const token = await login('admin');
  const r = await get('/audit-logs', { token });
  assert.equal(r.status, 403, `admin should be denied audit, got ${r.status} ${JSON.stringify(r.body)}`);
});

test('RBAC: finance GET /audit-logs → 403', async () => {
  const token = await login('finance');
  const r = await get('/audit-logs', { token });
  assert.equal(r.status, 403, `finance should be denied audit, got ${r.status}`);
});

// ---- Record payment: all roles allowed (per §3.6 + matrix) ----
test('RBAC: all four roles can view invoices list (All)', async () => {
  for (const role of ['owner', 'manager', 'admin', 'finance']) {
    const token = await login(role);
    const r = await get('/invoices', { token });
    assert.equal(r.status, 200, `${role} invoice list, got ${r.status}`);
  }
});
