import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, login, registerTenant } from './helpers.mjs';

test('tenant isolation: tenant B cannot read tenant A property (404, no leak)', async () => {
  // Tenant A = seeded demo; create a property in A as owner.
  const aOwner = await login('owner');
  const aProp = await post('/properties', {
    name: 'IsoProp ' + Date.now(), type: 'campur', address: 'Jl Isolasi 1', city: 'Bandung', province: 'Jawa Barat',
  }, { token: aOwner });
  assert.ok(aProp.status >= 200 && aProp.status < 300, `create A prop: ${aProp.status} ${JSON.stringify(aProp.body)}`);
  const aPropId = aProp.body.data.id;

  // Tenant B = fresh registration.
  const b = await registerTenant('iso');
  const bView = await get(`/properties/${aPropId}`, { token: b.token });
  assert.equal(bView.status, 404, `B reading A property must be 404, got ${bView.status}`);
});

test("tenant isolation: B's property list never contains A's properties", async () => {
  const aOwner = await login('owner');
  const aProps = await get('/properties', { token: aOwner });
  const aIds = new Set(aProps.body.data.map((p) => p.id));

  const b = await registerTenant('iso2');
  const bProps = await get('/properties', { token: b.token });
  const bIds = bProps.body.data.map((p) => p.id);
  for (const id of bIds) {
    assert.ok(!aIds.has(id), 'B list must not contain any of A property ids');
  }
});

test('tenant isolation: B cannot read A invoice (404)', async () => {
  const aOwner = await login('owner');
  const aInv = await get('/invoices', { token: aOwner });
  const aInvId = aInv.body.data[0]?.id;
  if (!aInvId) return;
  const b = await registerTenant('iso3');
  const r = await get(`/invoices/${aInvId}`, { token: b.token });
  assert.equal(r.status, 404, `B reading A invoice must be 404, got ${r.status}`);
});

// ---- Property-access semantics (recent fix) ----
test('property-access: non-owner with EMPTY access sees ALL tenant properties (unrestricted)', async () => {
  const owner = await login('owner');
  // Ensure there are >=1 properties; count owner's view.
  const ownerProps = await get('/properties', { token: owner });
  const ownerCount = ownerProps.body.data.length;

  // admin demo user has empty property-access by default → should see all.
  const admin = await login('admin');
  const adminProps = await get('/properties', { token: admin });
  assert.equal(adminProps.status, 200);
  assert.equal(
    adminProps.body.data.length,
    ownerCount,
    `admin (empty access) should see all ${ownerCount} props, saw ${adminProps.body.data.length}`,
  );
});

test('property-access: restricting a user limits list + cross-property → NOT_FOUND', async () => {
  const owner = await login('owner');
  // Create a 2nd property so we can restrict to only the first.
  const props = await get('/properties', { token: owner });
  let allProps = props.body.data;
  if (allProps.length < 2) {
    const extra = await post('/properties', {
      name: 'ScopeExtra ' + Date.now(), type: 'campur', address: 'Jl Scope 2', city: 'Bandung', province: 'Jawa Barat',
    }, { token: owner });
    if (extra.status >= 200 && extra.status < 300) {
      allProps = (await get('/properties', { token: owner })).body.data;
    }
  }
  if (allProps.length < 2) {
    // plan cap may block a 2nd property; skip gracefully.
    return;
  }
  const allowed = allProps[0].id;
  const forbidden = allProps[1].id;

  // Find the admin demo user id, restrict to `allowed`.
  const users = await get('/users', { token: owner });
  const adminUser = users.body.data.find((u) => u.role === 'admin');
  assert.ok(adminUser, 'admin demo user present');

  const setAccess = await patch(`/users/${adminUser.id}/property-access`, {
    propertyIds: [allowed],
  }, { token: owner });
  assert.ok(setAccess.status >= 200 && setAccess.status < 300, `set access: ${setAccess.status} ${JSON.stringify(setAccess.body)}`);

  try {
    const admin = await login('admin');
    const adminList = await get('/properties', { token: admin });
    const ids = adminList.body.data.map((p) => p.id);
    assert.ok(ids.includes(allowed), 'restricted admin sees allowed property');
    assert.ok(!ids.includes(forbidden), 'restricted admin does NOT see forbidden property');

    const cross = await get(`/properties/${forbidden}`, { token: admin });
    assert.equal(cross.status, 404, `cross-property access must be 404, got ${cross.status}`);
  } finally {
    // Reset admin access to empty (unrestricted) so other tests are unaffected.
    await patch(`/users/${adminUser.id}/property-access`, { propertyIds: [] }, { token: owner });
  }
});
