import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../config/tenantStore';
import { reconcile } from '../modules/payments/payment-gateway.service';

/**
 * Daily payment reconciliation sweep (PRD §6.8). A repeatable job (env RECON_CRON, default 01:00
 * WIB) that, per tenant, logs a reconciliation summary for the CURRENT period — matched vs
 * unmatched gateway `paid` txns vs recorded payments vs invoices, flagging mismatches.
 *
 * In STUB mode this is mostly REPORTING (no auto-corrective action) — the webhook path already
 * records the Payment idempotently, so the sweep is a safety net / observability surface.
 *
 * Mirrors the bookingReleaser / reminderSender pattern:
 *   - PURE function `runPaymentReconcile(data)` (no BullMQ dependency) → directly testable.
 *   - IDEMPOTENT: read-only reporting (no writes) — running it N times changes nothing.
 *   - PER-TENANT scoped: each tenant's reconcile runs inside runWithTenant so the Prisma
 *     tenant-guard auto-scopes queries. Cross-tenant enumeration uses a raw (un-extended) client.
 *   - FAILURE ISOLATION: try/catch per tenant — one tenant's failure never aborts the run.
 *   - STRUCTURED LOGS: run.start / tenant.reconciled / tenant.error / run.done.
 */

const rawPrisma = new PrismaClient();

export interface ReconcileJobData {
  /** Evaluate against this period (defaults to "now"). Tests pass a value. */
  month?: number;
  year?: number;
  /** Restrict the run to a single tenant. Omit = all tenants. */
  tenantId?: string;
  source?: string;
}

export interface ReconcileSummary {
  period: { month: number; year: number };
  tenantsScanned: number;
  tenantsWithMismatch: number;
  tenants: {
    tenantId: string;
    reconciled?: boolean;
    paidTxnCount?: number;
    unmatchedCount?: number;
    flags?: { code: string; message: string }[];
    error?: string;
  }[];
  durationMs: number;
}

function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    job: 'payment-reconcile',
    event,
    ...fields,
  });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

/** Execute one reconciliation sweep. Pure over `data` (no BullMQ dependency) → directly testable. */
export async function runPaymentReconcile(data: ReconcileJobData = {}): Promise<ReconcileSummary> {
  const startedAt = Date.now();
  const now = new Date();
  const month = data.month ?? now.getMonth() + 1;
  const year = data.year ?? now.getFullYear();

  log('info', 'run.start', {
    source: data.source ?? 'cron',
    period: `${year}-${String(month).padStart(2, '0')}`,
    tenantFilter: data.tenantId ?? null,
  });

  const tenants = await rawPrisma.tenant.findMany({
    where: { ...(data.tenantId ? { id: data.tenantId } : {}) },
    select: { id: true },
  });

  const tenantResults: ReconcileSummary['tenants'] = [];
  let tenantsScanned = 0;
  let tenantsWithMismatch = 0;

  for (const tenant of tenants) {
    tenantsScanned++;
    try {
      const result = await runWithTenant({ tenantId: tenant.id }, () =>
        // scope undefined = owner-level (all properties) inside the tenant guard.
        reconcile({ month, year }, undefined),
      );
      if (!result.reconciled) tenantsWithMismatch++;
      tenantResults.push({
        tenantId: tenant.id,
        reconciled: result.reconciled,
        paidTxnCount: result.gateway.paidTxnCount,
        unmatchedCount: result.gateway.unmatchedCount,
        flags: result.flags,
      });
      log('info', 'tenant.reconciled', {
        tenantId: tenant.id,
        reconciled: result.reconciled,
        paidTxnCount: result.gateway.paidTxnCount,
        unmatchedCount: result.gateway.unmatchedCount,
        flags: result.flags.map((f) => f.code),
      });
    } catch (e) {
      tenantResults.push({ tenantId: tenant.id, error: (e as Error).message });
      log('error', 'tenant.error', { tenantId: tenant.id, error: (e as Error).message });
    }
  }

  const summary: ReconcileSummary = {
    period: { month, year },
    tenantsScanned,
    tenantsWithMismatch,
    tenants: tenantResults,
    durationMs: Date.now() - startedAt,
  };

  log('info', 'run.done', {
    source: data.source ?? 'cron',
    tenantsScanned,
    tenantsWithMismatch,
    durationMs: summary.durationMs,
  });

  return summary;
}

/** Release the raw client (worker shutdown + test teardown). */
export async function disconnectPaymentReconciler(): Promise<void> {
  await rawPrisma.$disconnect();
}
