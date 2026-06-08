import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, put, patch, registerTenant, login } from './helpers.mjs';

// Build an isolated fresh tenant with a full data graph so lifecycle tests don't
// mutate the shared seed. Premium plan is set via change-plan to avoid cap blocks.
let T; // { token, propertyId, roomId, residentId }

before(async () => {
  const reg = await registerTenant('mod');
  const token = reg.token;
  // Bump caps so we can create multiple rooms/properties.
  await post('/subscription/change-plan', { plan: 'premium' }, { token });

  const prop = await post('/properties', {
    name: 'ModProp', type: 'campur', address: 'Jl Test', city: 'Bandung', province: 'Jabar',
    billingDay: 1, lateFeeType: 'flat', lateFeeValue: 25000, lateFeeGraceDays: 3, electricityPriceKwh: 1500,
  }, { token });
  assert.ok(prop.status >= 200 && prop.status < 300, `prop create ${prop.status} ${JSON.stringify(prop.body)}`);
  const propertyId = prop.body.data.id;

  const room = await post(`/properties/${propertyId}/rooms`, {
    roomNumber: 'M1', roomType: 'standard', floor: 1, areaM2: 12, basePrice: 1000000,
  }, { token });
  assert.ok(room.status >= 200 && room.status < 300, `room create ${room.status} ${JSON.stringify(room.body)}`);
  const roomId = room.body.data.id;

  T = { token, propertyId, roomId };
});

// ---------- Properties ----------
test('property detail returns stats block', async () => {
  const r = await get(`/properties/${T.propertyId}`, { token: T.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.stats, 'stats present');
  assert.ok('occupancyRate' in r.body.data.stats);
});

// ---------- Rooms: status, clone, bulk-price, list via /properties/:id/rooms ----------
test('rooms: list via /properties/:id/rooms', async () => {
  const r = await get(`/properties/${T.propertyId}/rooms`, { token: T.token });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.data.find((x) => x.id === T.roomId));
});

test('rooms: PATCH status to maintenance', async () => {
  const r = await patch(`/rooms/${T.roomId}/status`, { status: 'maintenance' }, { token: T.token });
  assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.data.status, 'maintenance');
  // reset to empty for resident creation later
  await patch(`/rooms/${T.roomId}/status`, { status: 'empty' }, { token: T.token });
});

test('rooms: clone creates N rooms', async () => {
  const r = await post(`/rooms/${T.roomId}/clone`, { count: 2, roomNumberPrefix: 'C' }, { token: T.token });
  assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body.data) && r.body.data.length === 2, `expected 2 cloned, got ${JSON.stringify(r.body.data)}`);
});

test('rooms: bulk-price percent adjust returns updated count', async () => {
  const r = await post(`/properties/${T.propertyId}/rooms/bulk-price`, {
    filter: { roomType: 'standard' }, adjustType: 'percent', value: 10,
  }, { token: T.token });
  assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(typeof r.body.data.updated === 'number' && r.body.data.updated >= 1);
});

// ---------- Residents: create + occupancy + NIK encryption + nikLast4 ----------
test('residents: create sets room occupied, encrypts NIK, exposes nikLast4', async () => {
  const nik = '3201234567890999';
  const r = await post('/residents', {
    propertyId: T.propertyId, roomId: T.roomId, fullName: 'Resident QA', nik, phone: '081234567890',
    email: 'res.qa@x.id', gender: 'male', checkInDate: '2026-06-01', contractEndDate: '2027-06-01',
    monthlyRent: 1000000, emergencyContact: { name: 'Ibu', phone: '0813', relation: 'Ibu' },
  }, { token: T.token });
  assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
  T.residentId = r.body.data.id;

  // List masks NIK
  const list = await get('/residents', { token: T.token });
  const inList = list.body.data.find((x) => x.id === T.residentId);
  assert.ok(inList, 'resident in list');
  assert.ok(inList.nik === undefined || inList.nik === null, 'raw nik not in list');
  if (inList.nikMasked) assert.ok(inList.nikMasked.endsWith('0999'), 'nikLast4 visible in mask');

  // Room now occupied
  const room = await get(`/rooms/${T.roomId}`, { token: T.token });
  assert.equal(room.body.data.status, 'occupied', 'room set occupied after resident create');

  // Detail returns decrypted NIK to owner (Admin+)
  const detail = await get(`/residents/${T.residentId}`, { token: T.token });
  assert.equal(detail.body.data.nik, nik, 'owner sees decrypted NIK on detail');
  assert.ok(Array.isArray(detail.body.data.occupancyHistory), 'occupancy history present');
  assert.ok(detail.body.data.occupancyHistory.length >= 1, 'one active occupancy opened');
});

// ---------- Invoices: generate idempotency ----------
test('invoices: generate then re-generate same period is idempotent (skipped)', async () => {
  const first = await post('/invoices/generate', {
    propertyId: T.propertyId, periodMonth: 7, periodYear: 2026,
  }, { token: T.token });
  assert.ok(first.status >= 200 && first.status < 300, `${first.status} ${JSON.stringify(first.body)}`);
  assert.ok(first.body.data.created >= 1, `expected created>=1, got ${first.body.data.created}`);

  const second = await post('/invoices/generate', {
    propertyId: T.propertyId, periodMonth: 7, periodYear: 2026,
  }, { token: T.token });
  assert.equal(second.body.data.created, 0, 'idempotent: nothing created on re-run');
  assert.ok(second.body.data.skipped >= 1, 'idempotent: existing skipped');
});

// ---------- Payments: partial → paid → overpay 422 ----------
test('payments: partial then full transition, overpay → 422', async () => {
  // Find the invoice generated above.
  const inv = await get('/invoices', { token: T.token, query: { period_month: 7, period_year: 2026 } });
  const invoice = inv.body.data[0];
  assert.ok(invoice, 'generated invoice found');
  const total = Number(invoice.totalAmount);
  assert.ok(total > 0, 'invoice has positive total');

  // Partial payment (half).
  const half = Math.floor(total / 2);
  const p1 = await post(`/invoices/${invoice.id}/payment`, {
    amount: half, method: 'cash', paidAt: '2026-07-05',
  }, { token: T.token });
  assert.ok(p1.status >= 200 && p1.status < 300, `partial pay ${p1.status} ${JSON.stringify(p1.body)}`);
  const afterPartial = await get(`/invoices/${invoice.id}`, { token: T.token });
  assert.equal(afterPartial.body.data.status, 'partial', 'status partial after half payment');

  // Overpay (more than remaining) → 422.
  const over = await post(`/invoices/${invoice.id}/payment`, {
    amount: total, method: 'cash', paidAt: '2026-07-06',
  }, { token: T.token });
  assert.equal(over.status, 422, `overpay should be 422, got ${over.status} ${JSON.stringify(over.body)}`);

  // Pay remaining exactly → paid.
  const remaining = total - half;
  const p2 = await post(`/invoices/${invoice.id}/payment`, {
    amount: remaining, method: 'cash', paidAt: '2026-07-07',
  }, { token: T.token });
  assert.ok(p2.status >= 200 && p2.status < 300, `final pay ${p2.status} ${JSON.stringify(p2.body)}`);
  const afterFull = await get(`/invoices/${invoice.id}`, { token: T.token });
  assert.equal(afterFull.body.data.status, 'paid', 'status paid after full payment');
});

// ---------- Resident checkout: occupancy closed, room empty, status alumni ----------
test('residents: checkout sets alumni, room empty, occupancy closed', async () => {
  const r = await post(`/residents/${T.residentId}/checkout`, {
    checkOutDate: '2026-12-31', notes: 'end of contract',
  }, { token: T.token });
  assert.ok(r.status >= 200 && r.status < 300, `checkout ${r.status} ${JSON.stringify(r.body)}`);

  const detail = await get(`/residents/${T.residentId}`, { token: T.token });
  assert.equal(detail.body.data.status, 'alumni', 'resident alumni after checkout');

  const room = await get(`/rooms/${T.roomId}`, { token: T.token });
  assert.equal(room.body.data.status, 'empty', 'room empty after checkout');

  const active = detail.body.data.occupancyHistory.filter((o) => o.status === 'active');
  assert.equal(active.length, 0, 'no active occupancy after checkout');
});

test('residents: blacklist status transition', async () => {
  const r = await patch(`/residents/${T.residentId}/status`, { status: 'blacklisted' }, { token: T.token });
  assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.data.status, 'blacklisted');
});

// ---------- Subscription usage/limits + planGuard ----------
test('subscription: returns plan/limits/usage shape', async () => {
  const r = await get('/subscription', { token: T.token });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.ok(d.limits && 'maxProperties' in d.limits);
  assert.ok(d.usage && 'properties' in d.usage);
  assert.ok(d.usage.properties >= 1);
});

test('planGuard: exceeding max_properties on basic plan → 403 PLAN_LIMIT_EXCEEDED', async () => {
  // Fresh tenant on basic plan (cap 1 property). It already has 0; create 1, then 2nd must fail.
  const reg = await registerTenant('cap');
  const token = reg.token;
  const sub = await get('/subscription', { token });
  // ensure basic caps
  const maxProps = sub.body.data.limits.maxProperties;
  const cur = sub.body.data.usage.properties;
  // Create up to the cap.
  for (let i = cur; i < maxProps; i++) {
    const ok = await post('/properties', {
      name: `Cap${i}`, type: 'campur', address: 'Jl Cap 1', city: 'Bandung', province: 'Jawa Barat',
    }, { token });
    assert.ok(ok.status >= 200 && ok.status < 300, `cap-fill create ${ok.status} ${JSON.stringify(ok.body)}`);
  }
  // Next create exceeds cap.
  const over = await post('/properties', {
    name: 'CapOver', type: 'campur', address: 'Jl Cap 2', city: 'Bandung', province: 'Jawa Barat',
  }, { token });
  assert.equal(over.status, 403, `over-cap should be 403, got ${over.status} ${JSON.stringify(over.body)}`);
  assert.equal(over.body.code, 'PLAN_LIMIT_EXCEEDED');
});

// ---------- Dashboard overview shape ----------
test('dashboard: overview returns expected keys', async () => {
  const r = await get('/dashboard/overview', { token: T.token });
  assert.equal(r.status, 200);
  const d = r.body.data;
  for (const k of ['totalProperties', 'totalRooms', 'occupied', 'occupancyRate', 'monthRevenue', 'outstandingAmount', 'outstandingCount', 'activeResidents']) {
    assert.ok(k in d, `dashboard missing key ${k}`);
  }
});

// ---------- Audit logs written on mutations + immutable ----------
test('audit-logs: mutations produced entries; no write routes', async () => {
  const list = await get('/audit-logs', { token: T.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 1, 'audit entries present after mutations');
  // Immutability: POST/PUT/DELETE/PATCH should not exist (404 or 405, never 2xx).
  const tryCreate = await post('/audit-logs', { action: 'hack' }, { token: T.token });
  assert.ok(tryCreate.status >= 400, `audit create must be rejected, got ${tryCreate.status}`);
  if (list.body.data[0]) {
    const id = list.body.data[0].id;
    const tryDel = await patch(`/audit-logs/${id}`, { action: 'tamper' }, { token: T.token });
    assert.ok(tryDel.status >= 400, `audit update must be rejected, got ${tryDel.status}`);
  }
});
