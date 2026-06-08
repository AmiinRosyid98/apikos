import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request tenant context. Populated by tenantContext middleware (B2.3) and read by
 * the Prisma tenant-guard extension (B1.3) to auto-scope every query.
 */
export interface TenantStore {
  tenantId: string;
  userId?: string;
  /** When true, the tenant-guard is bypassed (used by auth/login before tenant is known). */
  bypass?: boolean;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function getTenantStore(): TenantStore | undefined {
  return tenantStorage.getStore();
}

export function runWithTenant<T>(store: TenantStore, fn: () => T): T {
  return tenantStorage.run(store, fn);
}

/** Run a callback with the tenant-guard disabled (e.g. auth flows, seeding). */
export function runUnscoped<T>(fn: () => T): T {
  return tenantStorage.run({ tenantId: '__unscoped__', bypass: true }, fn);
}
