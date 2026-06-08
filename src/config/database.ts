import { PrismaClient, Prisma } from '@prisma/client';
import { getTenantStore } from './tenantStore';
import { isProd } from './env';

/**
 * Prisma tenant-guard (PLAN B1.3, design fix a). Defense-in-depth alongside Postgres RLS:
 * every read is filtered by tenant_id and every write injects tenant_id from the request
 * AsyncLocalStorage context. Models without a tenant_id column are skipped.
 */

// Models that do NOT carry a tenant_id column → never auto-scoped.
const MODELS_WITHOUT_TENANT = new Set<string>([
  'Tenant',
  'PasswordReset', // scoped by user, no tenantId column
]);

// Write operations that must have tenant_id injected into `data`.
const CREATE_OPS = new Set(['create', 'createMany']);
const WHERE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);
// Unique-target ops: Prisma forbids non-unique fields in `where` for these, so we cannot
// safely inject tenant_id there. We rely on RLS + the fact that ids are UUIDs + explicit
// service-layer checks for these. (findUnique/update/delete/upsert)

function basePrisma(): PrismaClient {
  return new PrismaClient({
    log: isProd ? ['warn', 'error'] : ['warn', 'error'],
  });
}

function makeClient() {
  return basePrisma().$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const store = getTenantStore();
          // No context or explicit bypass → run as-is (auth flows, seed).
          if (!store || store.bypass) {
            return query(args);
          }
          if (model && MODELS_WITHOUT_TENANT.has(model)) {
            return query(args);
          }
          const tenantId = store.tenantId;
          const a: any = args ?? {};

          if (CREATE_OPS.has(operation)) {
            if (operation === 'createMany') {
              if (Array.isArray(a.data)) {
                a.data = a.data.map((d: any) => ({ tenantId, ...d }));
              }
            } else if (a.data) {
              if (a.data.tenantId === undefined) a.data.tenantId = tenantId;
            }
            return query(a);
          }

          if (WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), tenantId };
            return query(a);
          }

          // findUnique / update / delete / upsert: enforced by RLS + service checks.
          return query(a);
        },
      },
    },
  });
}

type ExtendedPrisma = ReturnType<typeof makeClient>;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrisma };

export const prisma: ExtendedPrisma = globalForPrisma.prisma ?? makeClient();

if (!isProd) globalForPrisma.prisma = prisma;

export { Prisma };
