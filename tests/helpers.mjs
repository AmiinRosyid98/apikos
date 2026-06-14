// Shared test helpers for KosManager backend integration tests.
// Runs against a LIVE backend on http://localhost:4100 (PORT=4100 from apikos/.env).
// No external deps: uses Node 20+ global fetch + node:test.

export const BASE = process.env.KOS_TEST_BASE || 'http://localhost:4100/api/v1';

export const DEMO = {
  owner: { email: 'owner@demo.kos', password: 'Password123!' },
  manager: { email: 'manager@demo.kos', password: 'Password123!' },
  admin: { email: 'admin@demo.kos', password: 'Password123!' },
  finance: { email: 'finance@demo.kos', password: 'Password123!' },
};

/** Low-level request. Returns { status, body, headers }. */
export async function req(method, path, { token, body, query } = {}) {
  let url = path.startsWith('http') ? path : BASE + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export const get = (p, o) => req('GET', p, o);
export const post = (p, body, o = {}) => req('POST', p, { ...o, body });
export const put = (p, body, o = {}) => req('PUT', p, { ...o, body });
export const patch = (p, body, o = {}) => req('PATCH', p, { ...o, body });
export const del = (p, o) => req('DELETE', p, o);

// Cache demo-account access tokens for the run so we don't hammer the public
// login route (rate-limited at 100 req/min/IP). Tokens last 15m — plenty for a run.
const _tokenCache = new Map();

/** Log in a demo account (cached), return its accessToken. Retries once on 429. */
export async function login(which = 'owner') {
  if (_tokenCache.has(which)) return _tokenCache.get(which);
  const creds = DEMO[which];
  let r = await post('/auth/login', creds);
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 1500));
    r = await post('/auth/login', creds);
  }
  if (r.status !== 200) {
    throw new Error(`login(${which}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  _tokenCache.set(which, r.body.data.accessToken);
  return r.body.data.accessToken;
}

/** Log in and return full data (user + tokens). */
export async function loginFull(which = 'owner') {
  const r = await post('/auth/login', DEMO[which]);
  if (r.status !== 200) throw new Error(`login(${which}) failed: ${r.status}`);
  return r.body.data;
}

/** Decode a JWT payload (no signature verification — just to read claims). */
export function decodeJwt(token) {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

let _seq = 0;
export function uniqueEmail(prefix = 'qa') {
  _seq += 1;
  return `${prefix}.${Date.now()}.${_seq}@qa-test.kos`;
}

// BUG-005: track every tenant we register so suites can cascade-delete them on
// teardown. Without this, `QA Tenant *` tenants accumulate (reseed only resets
// `demo-kos`). Each suite must call `await cleanupTenants()` in an `after()` hook.
const _createdTenantIds = new Set();

/** Register a brand-new tenant+owner; returns { token, refreshToken, tenant, user, email }. */
export async function registerTenant(label = 'qa') {
  const email = uniqueEmail(label);
  const body = {
    businessName: `QA Tenant ${label} ${Date.now()}`,
    fullName: `QA ${label}`,
    email,
    password: 'Password123!',
    phone: '081200000000',
  };
  let r = await post('/auth/register', body);
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 1500));
    r = await post('/auth/register', body);
  }
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const tenant = r.body.data.tenant;
  if (tenant?.id) _createdTenantIds.add(tenant.id);
  return {
    token: r.body.data.accessToken,
    refreshToken: r.body.data.refreshToken,
    tenant,
    user: r.body.data.user,
    email,
  };
}

/**
 * BUG-005 teardown helper: hard-delete rows the integration suites had to create
 * inside an *existing* tenant (e.g. a demo `ScopeExtra` property). Cascade-deletes
 * by id via a direct PrismaClient so reseed isn't required to restore the baseline.
 */
export async function deletePropertiesById(ids = []) {
  const list = ids.filter(Boolean);
  if (list.length === 0) return;
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    for (const id of list) {
      await prisma.property.delete({ where: { id } }).catch(() => {});
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * BUG-005 teardown: cascade-delete every tenant registered via registerTenant()
 * during this process, so no orphan `QA Tenant *` rows remain after a run.
 * Uses a direct (un-extended) PrismaClient — tenant delete cascades to all
 * child rows (FKs declared onDelete: Cascade). Never touches `demo-kos`.
 * Safe to call multiple times (idempotent; clears the tracked set).
 */
export async function cleanupTenants() {
  if (_createdTenantIds.size === 0) return;
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    for (const id of _createdTenantIds) {
      await prisma.tenant.delete({ where: { id } }).catch(() => {});
    }
    _createdTenantIds.clear();
  } finally {
    await prisma.$disconnect();
  }
}
