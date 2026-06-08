import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../config/tenantStore';
import { generateInvoices } from '../modules/invoices/invoices.service';
import { env } from '../config/env';
import type { InvoiceJobData } from './queue';

/**
 * Automatic monthly invoice generation (PRD §6.7, §14.1; mitigates Risk #2 "downtime at
 * billing date"). Runs daily (00:30 WIB default). For every active tenant, for every active
 * property whose `billingDay === today's day-of-month (WIB)`, generate the current-period
 * invoice for each active resident — REUSING the same `generateInvoices` service that backs
 * the manual `POST /invoices/generate` endpoint (no duplicated billing logic).
 *
 * IDEMPOTENCY (critical): `generateInvoices` skips residents already invoiced for the period
 * (unique `(tenant_id, resident_id, period_month, period_year)` + P2002 race handling), so a
 * run is safe to execute multiple times per day — the second run generates 0, skips all.
 *
 * ISOLATION: each tenant + property unit is wrapped in try/catch; one failure never aborts
 * the whole run. Each tenant's generation executes inside `runWithTenant` so the Prisma
 * tenant-guard (AsyncLocalStorage) scopes every query — exactly like the seed/manual path.
 *
 * FUTURE SEAMS (NOT built here):
 *   - Meter-based electricity components: `generateInvoices` already supports configured
 *     components; a meter-reading module (MVP-2) would inject electricity items before the
 *     call. See TODO below.
 *   - Reminder scheduling (H-7…H+7) + WhatsApp send: after a successful per-property
 *     generation we would enqueue reminder jobs. See TODO below.
 */

// Raw (un-extended) client for CROSS-TENANT enumeration only. We must read tenants/properties
// across tenant boundaries to drive the run; per-tenant *generation* goes through the
// tenant-scoped extended client inside runWithTenant. Mirrors the seed's raw-client approach.
const rawPrisma = new PrismaClient();

export interface PropertyRunResult {
  propertyId: string;
  propertyName: string;
  billingDay: number;
  periodMonth: number;
  periodYear: number;
  generated: number;
  skipped: number;
  error?: string;
}

export interface TenantRunResult {
  tenantId: string;
  tenantName: string;
  propertiesProcessed: number;
  generated: number;
  skipped: number;
  results: PropertyRunResult[];
  error?: string;
}

export interface InvoiceRunSummary {
  asOf: string;
  dayOfMonth: number;
  tenantsScanned: number;
  propertiesMatched: number;
  totalGenerated: number;
  totalSkipped: number;
  tenants: TenantRunResult[];
  durationMs: number;
}

/**
 * Day-of-month in Asia/Jakarta (WIB) for the given instant. Billing days are WIB-local
 * (A9) — using UTC `getDate()` would misfire near midnight. We derive it via Intl so the
 * cron fires on the correct calendar day regardless of server TZ.
 */
function wibDateParts(at: Date): { day: number; month: number; year: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.INVOICE_CRON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { day: get('day'), month: get('month'), year: get('year') };
}

function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    job: 'invoice-generation',
    event,
    ...fields,
  });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

/**
 * Execute one invoice-generation run. Pure function over `data` (no BullMQ dependency) so it
 * is directly unit/integration-testable. The processor and the test both call this.
 */
export async function runInvoiceGeneration(data: InvoiceJobData = {}): Promise<InvoiceRunSummary> {
  const startedAt = Date.now();
  const asOf = data.asOf ? new Date(data.asOf) : new Date();
  const { day: dayOfMonth, month: periodMonth, year: periodYear } = wibDateParts(asOf);

  log('info', 'run.start', {
    source: data.source ?? 'cron',
    asOf: asOf.toISOString(),
    dayOfMonth,
    periodMonth,
    periodYear,
    tenantFilter: data.tenantId ?? null,
  });

  const tenants = await rawPrisma.tenant.findMany({
    where: {
      subscriptionStatus: 'active',
      ...(data.tenantId ? { id: data.tenantId } : {}),
    },
    select: { id: true, name: true },
  });

  const tenantResults: TenantRunResult[] = [];
  let totalGenerated = 0;
  let totalSkipped = 0;
  let propertiesMatched = 0;

  for (const tenant of tenants) {
    const tenantResult: TenantRunResult = {
      tenantId: tenant.id,
      tenantName: tenant.name,
      propertiesProcessed: 0,
      generated: 0,
      skipped: 0,
      results: [],
    };

    try {
      // Active properties whose billingDay matches today (WIB). Read with the raw client but
      // explicitly tenant-filtered (we are outside a tenant context here).
      const properties = await rawPrisma.property.findMany({
        where: { tenantId: tenant.id, isActive: true, billingDay: dayOfMonth },
        select: { id: true, name: true, billingDay: true },
      });

      for (const property of properties) {
        propertiesMatched++;
        const pResult: PropertyRunResult = {
          propertyId: property.id,
          propertyName: property.name,
          billingDay: property.billingDay,
          periodMonth,
          periodYear,
          generated: 0,
          skipped: 0,
        };

        try {
          // Run generation inside the tenant scope so the Prisma tenant-guard auto-scopes
          // every query — identical code path to the manual endpoint (which runs inside
          // tenantContext middleware). REUSES generateInvoices (no duplicated billing logic).
          const result = await runWithTenant({ tenantId: tenant.id }, () =>
            generateInvoices(tenant.id, {
              propertyId: property.id,
              periodMonth,
              periodYear,
            }),
          );

          pResult.generated = result.created;
          pResult.skipped = result.skipped;
          tenantResult.generated += result.created;
          tenantResult.skipped += result.skipped;
          totalGenerated += result.created;
          totalSkipped += result.skipped;

          // TODO (MVP-2 reminder seam): after a successful generation, enqueue reminder jobs
          // (H-7…H+7) + WhatsApp invoice-send for the created invoices here. Intentionally
          // not built now — leave this as the single trigger point.
          // e.g. await enqueueReminders(tenant.id, property.id, result.invoices);
        } catch (e) {
          pResult.error = (e as Error).message;
          log('error', 'property.error', {
            tenantId: tenant.id,
            propertyId: property.id,
            error: pResult.error,
          });
        }

        tenantResult.propertiesProcessed++;
        tenantResult.results.push(pResult);
        log('info', 'property.done', {
          tenantId: tenant.id,
          tenantName: tenant.name,
          propertyId: property.id,
          propertyName: property.name,
          billingDay: property.billingDay,
          generated: pResult.generated,
          skipped: pResult.skipped,
          error: pResult.error ?? null,
        });
      }
    } catch (e) {
      // Tenant-level failure must NOT abort the whole run.
      tenantResult.error = (e as Error).message;
      log('error', 'tenant.error', { tenantId: tenant.id, error: tenantResult.error });
    }

    tenantResults.push(tenantResult);
  }

  const summary: InvoiceRunSummary = {
    asOf: asOf.toISOString(),
    dayOfMonth,
    tenantsScanned: tenants.length,
    propertiesMatched,
    totalGenerated,
    totalSkipped,
    tenants: tenantResults,
    durationMs: Date.now() - startedAt,
  };

  log('info', 'run.done', {
    source: data.source ?? 'cron',
    tenantsScanned: summary.tenantsScanned,
    propertiesMatched: summary.propertiesMatched,
    totalGenerated: summary.totalGenerated,
    totalSkipped: summary.totalSkipped,
    durationMs: summary.durationMs,
  });

  return summary;
}

/** Release the raw client (used by the worker shutdown + test teardown). */
export async function disconnectInvoiceGenerator(): Promise<void> {
  await rawPrisma.$disconnect();
}
