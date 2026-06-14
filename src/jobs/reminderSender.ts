import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../config/tenantStore';
import { prisma } from '../config/database';
import {
  resolveReminderConfig,
  resolveTemplateBody,
  renderForContext,
  sendViaProvider,
  getQuota,
} from '../modules/whatsapp/whatsapp.service';
import { notify } from '../services/notification.service';

/**
 * Reminder Otomatis sweep (PRD §6.10). A repeatable daily job (env REMINDER_CRON, default 08:00
 * WIB) that, per tenant/property with reminderConfig.enabled:
 *   - scans unpaid/overdue invoices, computes days-to-dueDate, and for each ENABLED offset that
 *     matches today (H-7/H-3/H-0/H+3/H+7) renders the appropriate template (reminder_due for
 *     pre/on-due, reminder_overdue for post-due) and sends via the provider + logs;
 *   - sends contract-expiry reminders (H-30/H-14/H-7) from resident.contractEndDate when present.
 *
 * Mirrors the bookingReleaser / invoiceGenerator pattern:
 *   - PURE function `runReminderSweep(data)` (no BullMQ dependency) → directly testable.
 *   - IDEMPOTENT: each (invoice|resident, reminderKey) is guarded by a wa_messages lookup so the
 *     same offset is never sent twice. A second run the same day sends 0.
 *   - PER-TENANT scoped: each tenant's work runs inside runWithTenant so the Prisma tenant-guard
 *     auto-scopes queries. Cross-tenant enumeration uses a raw (un-extended) client.
 *   - FAILURE ISOLATION: try/catch per tenant / per property / per invoice.
 *   - QUOTA-AWARE: stops sending for a tenant once the monthly quota is exhausted.
 *   - STRUCTURED LOGS: run.start / reminder.sent / *.error / run.done.
 */

const rawPrisma = new PrismaClient();

export interface ReminderJobData {
  /** "today" the run evaluates offsets against. Defaults to now. Tests pass a value. */
  asOf?: string;
  /** Restrict the run to a single tenant. Omit = all tenants. */
  tenantId?: string;
  source?: string;
}

export interface ReminderSweepSummary {
  asOf: string;
  tenantsScanned: number;
  totalSent: number;
  totalSkipped: number; // already-sent (idempotent) or no-template hits skipped
  tenants: { tenantId: string; sent: number; skipped: number; error?: string }[];
  durationMs: number;
}

// Resolved reminder config shape (offsets + contractExpiry maps).
type ResolvedConfig = ReturnType<typeof resolveReminderConfig>;

/** Invoice-due offsets and their day delta (dueDate − today). */
const DUE_OFFSETS: {
  key: keyof ResolvedConfig['offsets'];
  delta: number;
  reminderKey: string;
  overdue: boolean;
}[] = [
  { key: 'h7', delta: 7, reminderKey: 'reminder_due:H-7', overdue: false },
  { key: 'h3', delta: 3, reminderKey: 'reminder_due:H-3', overdue: false },
  { key: 'h0', delta: 0, reminderKey: 'reminder_due:H-0', overdue: false },
  { key: 'h3plus', delta: -3, reminderKey: 'reminder_overdue:H+3', overdue: true },
  { key: 'h7plus', delta: -7, reminderKey: 'reminder_overdue:H+7', overdue: true },
];

const CONTRACT_OFFSETS: {
  key: keyof ResolvedConfig['contractExpiry'];
  delta: number;
  reminderKey: string;
}[] = [
  { key: 'h30', delta: 30, reminderKey: 'contract_expiry:H-30' },
  { key: 'h14', delta: 14, reminderKey: 'contract_expiry:H-14' },
  { key: 'h7', delta: 7, reminderKey: 'contract_expiry:H-7' },
];

function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    job: 'reminder-sweep',
    event,
    ...fields,
  });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

/** Whole-day difference (date-only, UTC) between two dates: `a − b` in days. */
export function daysBetween(a: Date, b: Date): number {
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((da - db) / 86_400_000);
}

/** Whether a reminder for this (invoice/resident, reminderKey) was already sent (idempotency). */
async function alreadySent(opts: {
  reminderKey: string;
  invoiceId?: string;
  residentId?: string;
}): Promise<boolean> {
  const existing = await prisma.waMessage.findFirst({
    where: {
      reminderKey: opts.reminderKey,
      status: { in: ['sent', 'stub'] },
      ...(opts.invoiceId ? { invoiceId: opts.invoiceId } : {}),
      ...(opts.residentId && !opts.invoiceId ? { residentId: opts.residentId } : {}),
    },
    select: { id: true },
  });
  return Boolean(existing);
}

/** Default window (days) for the contract/document-expiring in-app sweep (PRD §6.18). */
export const EXPIRING_WINDOW_DAYS = 30;

/**
 * Emit deduped IN-APP `contract_expiring` notifications (PRD §6.18) for a property's residents
 * whose `contractEndDate` falls within the next `EXPIRING_WINDOW_DAYS` (and any expiring tracked
 * `documents`). IDEMPOTENT: notify({ dedupe:true }) skips a recipient who already has an UNREAD
 * notification for the same (type, entity) — so a daily re-run does not pile up duplicates while
 * the previous one is unread. Best-effort: notify() is failure-isolated; this never throws.
 * Must run inside the tenant context (the caller wraps the whole sweep in runWithTenant).
 */
export async function emitContractExpiringNotifications(
  tenantId: string,
  propertyId: string,
  propertyName: string,
  asOf: Date,
): Promise<number> {
  let count = 0;
  const windowEnd = new Date(asOf.getTime() + EXPIRING_WINDOW_DAYS * 86_400_000);

  // Residents with a contract end date inside the window.
  const residents = await prisma.resident.findMany({
    where: {
      propertyId,
      status: 'active',
      contractEndDate: { gte: asOf, lte: windowEnd },
    },
    include: { room: true },
  });
  for (const r of residents) {
    if (!r.contractEndDate) continue;
    const days = daysBetween(r.contractEndDate, asOf);
    count += await notify({
      tenantId,
      type: 'contract_expiring',
      title: 'Kontrak akan berakhir',
      body: `Kontrak ${r.fullName}${r.room ? ` (kamar ${r.room.roomNumber})` : ''} di ${propertyName} berakhir dalam ${days} hari.`,
      link: `/residents/${r.id}`,
      entityType: 'resident',
      entityId: r.id,
      dedupe: true,
    });
  }

  // Tracked documents with an expiry inside the window (KTP/SIM/contract scans, etc.).
  const documents = await prisma.documentRecord.findMany({
    where: { propertyId, expiresAt: { gte: asOf, lte: windowEnd } },
  });
  for (const d of documents) {
    if (!d.expiresAt) continue;
    const days = daysBetween(d.expiresAt, asOf);
    count += await notify({
      tenantId,
      type: 'contract_expiring',
      title: 'Dokumen akan kedaluwarsa',
      body: `Dokumen "${d.name}" di ${propertyName} kedaluwarsa dalam ${days} hari.`,
      link: d.residentId ? `/residents/${d.residentId}` : '/documents',
      entityType: 'document',
      entityId: d.id,
      dedupe: true,
    });
  }

  return count;
}

/**
 * Execute one reminder sweep. Pure over `data` (no BullMQ dependency) so it is directly testable.
 */
export async function runReminderSweep(
  data: ReminderJobData = {},
): Promise<ReminderSweepSummary> {
  const startedAt = Date.now();
  const asOf = data.asOf ? new Date(data.asOf) : new Date();

  log('info', 'run.start', {
    source: data.source ?? 'cron',
    asOf: asOf.toISOString(),
    tenantFilter: data.tenantId ?? null,
  });

  // Enumerate tenants with at least one property (raw, explicitly filtered).
  const tenants = await rawPrisma.tenant.findMany({
    where: { ...(data.tenantId ? { id: data.tenantId } : {}) },
    select: { id: true, name: true },
  });

  const tenantResults: ReminderSweepSummary['tenants'] = [];
  let totalSent = 0;
  let totalSkipped = 0;
  let tenantsScanned = 0;

  for (const tenant of tenants) {
    const result = { tenantId: tenant.id, sent: 0, skipped: 0 } as {
      tenantId: string;
      sent: number;
      skipped: number;
      error?: string;
    };
    tenantsScanned++;
    try {
      await runWithTenant({ tenantId: tenant.id }, async () => {
        const quota = await getQuota(tenant.id, asOf);
        let remaining = quota.remaining; // null = unlimited

        const properties = await prisma.property.findMany({ where: { isActive: true } });
        for (const property of properties) {
          try {
            const cfg = resolveReminderConfig(property.reminderConfig);
            if (!cfg.enabled) continue;

            // ── Invoice due/overdue reminders ──
            const enabledDue = DUE_OFFSETS.filter((o) => cfg.offsets[o.key]);
            if (enabledDue.length) {
              const invoices = await prisma.invoice.findMany({
                where: { propertyId: property.id, status: { in: ['unpaid', 'partial', 'overdue'] } },
                include: { resident: true, room: true },
              });
              for (const inv of invoices) {
                if (!inv.resident.phone) continue;
                const delta = daysBetween(inv.dueDate, asOf); // dueDate − today
                const match = enabledDue.find((o) => o.delta === delta);
                if (!match) continue;
                if (remaining !== null && remaining <= 0) {
                  result.skipped++;
                  totalSkipped++;
                  continue;
                }
                if (await alreadySent({ reminderKey: match.reminderKey, invoiceId: inv.id })) {
                  result.skipped++;
                  totalSkipped++;
                  continue;
                }
                const templateType = match.overdue ? 'reminder_overdue' : 'reminder_due';
                const body = renderForContext(
                  await resolveTemplateBody(templateType, property.id),
                  {
                    residentName: inv.resident.fullName,
                    roomNumber: inv.room?.roomNumber ?? null,
                    invoiceAmount: Number(inv.totalAmount),
                    dueDate: inv.dueDate,
                    propertyName: property.name,
                  },
                );
                await sendViaProvider({
                  tenantId: tenant.id,
                  toPhone: inv.resident.phone,
                  toName: inv.resident.fullName,
                  body,
                  propertyId: property.id,
                  residentId: inv.residentId,
                  invoiceId: inv.id,
                  templateType,
                  reminderKey: match.reminderKey,
                });
                result.sent++;
                totalSent++;
                if (remaining !== null) remaining--;
                log('info', 'reminder.sent', {
                  tenantId: tenant.id,
                  propertyId: property.id,
                  invoiceId: inv.id,
                  reminderKey: match.reminderKey,
                });
              }
            }

            // ── Contract-expiry reminders ──
            const enabledContract = CONTRACT_OFFSETS.filter((o) => cfg.contractExpiry[o.key]);
            if (enabledContract.length) {
              const residents = await prisma.resident.findMany({
                where: { propertyId: property.id, status: 'active', contractEndDate: { not: null } },
                include: { room: true },
              });
              for (const r of residents) {
                if (!r.phone || !r.contractEndDate) continue;
                const delta = daysBetween(r.contractEndDate, asOf);
                const match = enabledContract.find((o) => o.delta === delta);
                if (!match) continue;
                if (remaining !== null && remaining <= 0) {
                  result.skipped++;
                  totalSkipped++;
                  continue;
                }
                if (await alreadySent({ reminderKey: match.reminderKey, residentId: r.id })) {
                  result.skipped++;
                  totalSkipped++;
                  continue;
                }
                const body = renderForContext(
                  await resolveTemplateBody('contract_expiry', property.id),
                  {
                    residentName: r.fullName,
                    roomNumber: r.room?.roomNumber ?? null,
                    invoiceAmount: null,
                    dueDate: r.contractEndDate,
                    propertyName: property.name,
                  },
                );
                await sendViaProvider({
                  tenantId: tenant.id,
                  toPhone: r.phone,
                  toName: r.fullName,
                  body,
                  propertyId: property.id,
                  residentId: r.id,
                  templateType: 'contract_expiry',
                  reminderKey: match.reminderKey,
                });
                result.sent++;
                totalSent++;
                if (remaining !== null) remaining--;
                log('info', 'reminder.sent', {
                  tenantId: tenant.id,
                  propertyId: property.id,
                  residentId: r.id,
                  reminderKey: match.reminderKey,
                });
              }
            }

            // ── IN-APP contract_expiring notifications (PRD §6.18) ──
            // Independent of the WA gate above (no phone required, runs even if WA offsets are off):
            // emit a deduped in-app notification for residents/contracts/documents expiring within
            // 30 days → owner/manager. Best-effort; notify() is failure-isolated.
            await emitContractExpiringNotifications(tenant.id, property.id, property.name, asOf);
          } catch (e) {
            log('error', 'property.error', {
              tenantId: tenant.id,
              propertyId: property.id,
              error: (e as Error).message,
            });
          }
        }
      });
    } catch (e) {
      result.error = (e as Error).message;
      log('error', 'tenant.error', { tenantId: tenant.id, error: result.error });
    }
    tenantResults.push(result);
  }

  const summary: ReminderSweepSummary = {
    asOf: asOf.toISOString(),
    tenantsScanned,
    totalSent,
    totalSkipped,
    tenants: tenantResults,
    durationMs: Date.now() - startedAt,
  };

  log('info', 'run.done', {
    source: data.source ?? 'cron',
    tenantsScanned,
    totalSent,
    totalSkipped,
    durationMs: summary.durationMs,
  });

  return summary;
}

/** Release the raw client (worker shutdown + test teardown). */
export async function disconnectReminderSender(): Promise<void> {
  await rawPrisma.$disconnect();
}
