import { test } from 'node:test';
import assert from 'node:assert/strict';
import { post, get, login, loginFull, decodeJwt, registerTenant } from './helpers.mjs';

test('health endpoint up + db up', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.data.db, 'up');
});

test('register creates new tenant + owner + tokens', async () => {
  const t = await registerTenant('reg');
  assert.ok(t.tenant.id, 'tenant id present');
  assert.equal(t.user.role, 'owner');
  assert.ok(t.token && t.refreshToken, 'tokens present');
});

test('register duplicate email → 409 CONFLICT', async () => {
  const t = await registerTenant('dup');
  const r = await post('/auth/register', {
    businessName: 'Dup Co',
    fullName: 'Dup',
    email: t.email,
    password: 'Password123!',
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CONFLICT');
});

test('register weak password (<8) → 422 VALIDATION_ERROR with errors[]', async () => {
  const r = await post('/auth/register', {
    businessName: 'Weak Co',
    fullName: 'Weak',
    email: 'weak.' + Date.now() + '@qa.kos',
    password: 'short',
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(r.body.errors) && r.body.errors.length > 0);
});

test('login success returns user + tokens', async () => {
  const data = await loginFull('owner');
  assert.equal(data.user.role, 'owner');
  assert.equal(data.user.email, 'owner@demo.kos');
  assert.ok(data.accessToken && data.refreshToken);
});

test('login wrong password → 401 UNAUTHENTICATED envelope', async () => {
  const r = await post('/auth/login', { email: 'owner@demo.kos', password: 'WrongPass99!' });
  assert.equal(r.status, 401);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, 'UNAUTHENTICATED');
});

test('login nonexistent user → 401 (no enumeration)', async () => {
  const r = await post('/auth/login', { email: 'nobody@qa.kos', password: 'Password123!' });
  assert.equal(r.status, 401);
});

test('JWT carries tenantId, userId, role claims', async () => {
  const token = await login('owner');
  const claims = decodeJwt(token);
  assert.ok(claims.tenantId, 'tenantId claim present');
  assert.ok(claims.userId, 'userId claim present');
  assert.equal(claims.role, 'owner');
});

test('two tenants get DIFFERENT tenantId in JWT', async () => {
  const a = await registerTenant('iso-a');
  const b = await registerTenant('iso-b');
  const ca = decodeJwt(a.token);
  const cb = decodeJwt(b.token);
  assert.notEqual(ca.tenantId, cb.tenantId);
});

test('GET /me returns profile + subscription shape', async () => {
  const token = await login('owner');
  const r = await get('/auth/me', { token });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.role, 'owner');
  assert.ok(d.tenantId);
  assert.ok(Array.isArray(d.propertyAccess));
  assert.ok(d.subscription && d.subscription.plan);
});

test('protected route without token → 401', async () => {
  const r = await get('/properties');
  assert.equal(r.status, 401);
});

test('refresh rotates token; old refresh token rejected on reuse', async () => {
  const t = await registerTenant('refresh');
  const first = await post('/auth/refresh', { refreshToken: t.refreshToken });
  assert.equal(first.status, 200, 'first refresh ok');
  assert.ok(first.body.data.accessToken && first.body.data.refreshToken);
  // Reuse the now-rotated (revoked) original refresh token → must be rejected.
  const reuse = await post('/auth/refresh', { refreshToken: t.refreshToken });
  assert.equal(reuse.status, 401, 'reused old refresh token rejected (rotation)');
});

test('logout revokes refresh token', async () => {
  const t = await registerTenant('logout');
  const out = await post('/auth/logout', { refreshToken: t.refreshToken }, { token: t.token });
  assert.ok(out.status === 200 || out.status === 204, `logout status ${out.status}`);
  const after = await post('/auth/refresh', { refreshToken: t.refreshToken });
  assert.equal(after.status, 401, 'refresh after logout rejected');
});

test('forgot-password always returns 200 (no enumeration)', async () => {
  const known = await post('/auth/forgot-password', { email: 'owner@demo.kos' });
  const unknown = await post('/auth/forgot-password', { email: 'ghost@qa.kos' });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
});
