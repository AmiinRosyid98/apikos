import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, login } from './helpers.mjs';

test('validation: malformed property body → 422 with {success,code,message,errors}', async () => {
  const token = await login('owner');
  const r = await post('/properties', { name: '' }, { token }); // missing required fields
  assert.equal(r.status, 422);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, 'VALIDATION_ERROR');
  assert.ok(typeof r.body.message === 'string');
  assert.ok(Array.isArray(r.body.errors) && r.body.errors.length > 0);
  assert.ok('field' in r.body.errors[0] && 'message' in r.body.errors[0]);
});

test('validation: bad login body → 422', async () => {
  const r = await post('/auth/login', { email: 'not-an-email' });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'VALIDATION_ERROR');
});

test('pagination: ?page&limit returns meta with page/limit/total/totalPages', async () => {
  const token = await login('owner');
  const r = await get('/properties', { token, query: { page: 1, limit: 5 } });
  assert.equal(r.status, 200);
  assert.ok(r.body.meta, 'meta present');
  for (const k of ['page', 'limit', 'total', 'totalPages']) {
    assert.ok(k in r.body.meta, `meta missing ${k}`);
  }
  assert.equal(r.body.meta.page, 1);
  assert.equal(r.body.meta.limit, 5);
});

test('files: non-whitelist content type → 422', async () => {
  const token = await login('owner');
  const r = await post('/files/presign-upload', {
    purpose: 'ktp', contentType: 'application/x-msdownload', fileName: 'virus.exe', sizeBytes: 1024,
  }, { token });
  assert.equal(r.status, 422, `non-whitelist type should be 422, got ${r.status} ${JSON.stringify(r.body)}`);
});

test('files: presign-upload whitelisted type succeeds (STUB url ok)', async () => {
  const token = await login('owner');
  const r = await post('/files/presign-upload', {
    purpose: 'ktp', contentType: 'image/jpeg', fileName: 'ktp.jpg', sizeBytes: 204800,
  }, { token });
  assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.body.data.key, 'returns object key');
  assert.ok(r.body.data.uploadUrl, 'returns (stub) upload url');
});

test('files: oversize (>10MB) → 422', async () => {
  const token = await login('owner');
  const r = await post('/files/presign-upload', {
    purpose: 'ktp', contentType: 'image/jpeg', fileName: 'big.jpg', sizeBytes: 11 * 1024 * 1024,
  }, { token });
  assert.equal(r.status, 422, `oversize should be 422, got ${r.status} ${JSON.stringify(r.body)}`);
});

test('files: presign-download authorizes only own-tenant key (404/403 on foreign key)', async () => {
  const token = await login('owner');
  const r = await post('/files/presign-download', { key: 'tenants/some-other-tenant/random.jpg' }, { token });
  assert.ok(r.status === 404 || r.status === 403, `foreign key download should be 404/403, got ${r.status} ${JSON.stringify(r.body)}`);
});
