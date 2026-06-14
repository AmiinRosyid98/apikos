import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, iso } from '../../utils/serialize';
import { encryptNullable } from '../../utils/crypto';
import { assertPlanFeature } from '../../services/plan.service';
import { getAccountingProvider, isProviderConfigured } from './providers/factory';
import type { TenantAccountingConfig } from './providers/factory';
import { mapPaymentToEntry, mapExpenseToEntry, isBalanced } from './mapping';
import type { AccountingEntryPayload } from './providers/provider';
import type { UpdateConfigInput, SyncInput, ListEntriesQuery } from './accounting.validators';

type EntryRow = Prisma.AccountingEntryGetPayload<object>;

// ─────────────────────────── Helpers ───────────────────────────
async function loadTenant(tenantId: string) {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: {
      accountingProvider: true,
      accountingEnabled: true,
      accountingApiKeyEnc: true,
      subscriptionPlan: true,
    },
  });
  if (!t) throw Errors.notFound('Tenant not found');
  return t;
}

function providerConfig(t: {
  accountingProvider: string | null;
  accountingApiKeyEnc: string | null;
}): TenantAccountingConfig {
  return { accountingProvider: t.accountingProvider, accountingApiKeyEnc: t.accountingApiKeyEnc };
}

export function serializeEntry(e: EntryRow) {
  return {
    id: e.id,
    provider: e.provider,
    entityType: e.entityType,
    entityId: e.entityId,
    entryType: e.entryType,
    amount: dec(e.amount),
    journalRef: e.journalRef,
    status: e.status,
    lines: e.lines,
    error: e.error,
    syncedAt: iso(e.syncedAt),
    createdAt: iso(e.createdAt),
  };
}

/**
 * Resolve the effective propertyId filter for a sync given the caller's property scope allowlist
 * (undefined = unrestricted). A restricted caller asking outside their scope matches nothing.
 */
function resolvePropertyFilter(
  requested: string | undefined,
  scope: string[] | undefined,
): string | { in: string[] } | undefined {
  if (scope === undefined) return requested ?? undefined;
  if (requested) return scope.includes(requested) ? requested : { in: ['__none__'] };
  return { in: scope };
}

/** First day of a month (UTC) and the first day of the next month — a half-open range. */
function monthRange(year: number, month: number) {
  return {
    gte: new Date(Date.UTC(year, month - 1, 1)),
    lt: new Date(Date.UTC(year, month, 1)),
  };
}

// ─────────────────────────── GET /accounting/status ───────────────────────────
export async function getStatus(tenantId: string) {
  const t = await loadTenant(tenantId);
  const provider = getAccountingProvider(providerConfig(t));

  const [pending, synced, failed, lastSynced] = await Promise.all([
    prisma.accountingEntry.count({ where: { status: 'pending' } }),
    prisma.accountingEntry.count({ where: { status: 'synced' } }),
    prisma.accountingEntry.count({ where: { status: 'failed' } }),
    prisma.accountingEntry.findFirst({
      where: { status: 'synced', syncedAt: { not: null } },
      orderBy: { syncedAt: 'desc' },
      select: { syncedAt: true },
    }),
  ]);

  return {
    provider: provider.name,
    connected: isProviderConfigured(providerConfig(t)),
    enabled: t.accountingEnabled,
    counts: { pending, synced, failed },
    lastSyncedAt: iso(lastSynced?.syncedAt ?? null),
  };
}

// ─────────────────────────── PUT /accounting/config (Owner-only, Premium) ───────────────────────────
export async function updateConfig(tenantId: string, input: UpdateConfigInput) {
  // Premium gate — Basic/Pro → 403 FORBIDDEN.
  await assertPlanFeature(tenantId, 'accountingIntegration');

  const data: {
    accountingProvider?: string | null;
    accountingEnabled?: boolean;
    accountingApiKeyEnc?: string | null;
  } = {};
  if ('provider' in input && input.provider !== undefined) data.accountingProvider = input.provider;
  if ('enabled' in input && input.enabled !== undefined) data.accountingEnabled = input.enabled;
  // apiKey: present + string → encrypt; present + null → clear; absent → leave intact.
  if ('apiKey' in input && input.apiKey !== undefined) {
    data.accountingApiKeyEnc = input.apiKey === null ? null : encryptNullable(input.apiKey);
  }

  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data,
    select: {
      accountingProvider: true,
      accountingEnabled: true,
      accountingApiKeyEnc: true,
    },
  });

  const provider = getAccountingProvider(providerConfig(updated));
  const result: {
    provider: string;
    enabled: boolean;
    connected: boolean;
    apiKeySet: boolean;
    testConnection?: { ok: boolean; message: string };
  } = {
    provider: provider.name,
    enabled: updated.accountingEnabled,
    connected: isProviderConfigured(providerConfig(updated)),
    apiKeySet: Boolean(updated.accountingApiKeyEnc),
  };

  if (input.testConnection) {
    result.testConnection = await provider.testConnection();
  }

  return result;
}

// ─────────────────────────── POST /accounting/sync ───────────────────────────
/**
 * Find un-synced payments + expenses (optionally scoped by period/property), map each to a journal,
 * push via the configured provider, and upsert an accounting_entries row (status + ref).
 *
 * Idempotent: an entity that already has a `synced` accounting_entries row is SKIPPED (never
 * duplicated) — backed by the unique (tenantId, entityType, entityId). A `failed`/`pending` prior
 * row is retried (re-pushed and updated in place).
 */
export async function sync(tenantId: string, input: SyncInput, scope: string[] | undefined) {
  const t = await loadTenant(tenantId);
  const provider = getAccountingProvider(providerConfig(t));

  const propFilter = resolvePropertyFilter(input.property_id, scope);
  const period = input.month && input.year ? monthRange(input.year, input.month) : undefined;

  // ── Income: received payments (joined to invoice for property scope + memo data) ──
  const payments = await prisma.payment.findMany({
    where: {
      ...(period ? { paidAt: period } : {}),
      ...(propFilter !== undefined ? { invoice: { propertyId: propFilter } } : {}),
    },
    select: {
      id: true,
      amount: true,
      paidAt: true,
      invoice: { select: { invoiceNumber: true, resident: { select: { fullName: true } } } },
    },
  });

  // ── Expense: recorded expenses (property scope on expense.propertyId; null = tenant-wide) ──
  const expenseWhere: Prisma.ExpenseWhereInput = {};
  if (period) expenseWhere.date = period;
  if (propFilter !== undefined) expenseWhere.propertyId = propFilter;
  const expenses = await prisma.expense.findMany({
    where: expenseWhere,
    select: {
      id: true,
      amount: true,
      date: true,
      description: true,
      category: { select: { name: true } },
    },
  });

  const entries: AccountingEntryPayload[] = [
    ...payments.map((p) =>
      mapPaymentToEntry({
        id: p.id,
        amount: Number(p.amount),
        paidAt: p.paidAt,
        invoiceNumber: p.invoice?.invoiceNumber ?? null,
        residentName: p.invoice?.resident?.fullName ?? null,
      }),
    ),
    ...expenses.map((e) =>
      mapExpenseToEntry({
        id: e.id,
        amount: Number(e.amount),
        date: e.date,
        categoryName: e.category?.name ?? null,
        description: e.description ?? null,
      }),
    ),
  ];

  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    // Idempotency: an already-synced entity is skipped (no duplicate, unique constraint holds).
    const existing = await prisma.accountingEntry.findFirst({
      where: { entityType: entry.entityType, entityId: entry.entityId },
      select: { id: true, status: true },
    });
    if (existing && existing.status === 'synced') {
      skipped++;
      continue;
    }

    // Defensive: never post an unbalanced journal (clamped to fail rather than corrupt).
    if (!isBalanced(entry.lines)) {
      await upsertEntry(tenantId, provider.name, entry, {
        status: 'failed',
        error: 'Journal is not balanced (debit !== credit)',
      });
      failed++;
      continue;
    }

    const result = await provider.pushEntry(entry); // NEVER throws
    if (result.status === 'synced') {
      await upsertEntry(tenantId, provider.name, entry, {
        status: 'synced',
        journalRef: result.ref,
        syncedAt: new Date(),
        error: null,
      });
      synced++;
    } else {
      await upsertEntry(tenantId, provider.name, entry, {
        status: 'failed',
        error: result.error ?? 'Provider returned failed',
      });
      failed++;
    }
  }

  return { synced, skipped, failed, total: entries.length };
}

async function upsertEntry(
  tenantId: string,
  providerName: string,
  entry: AccountingEntryPayload,
  patch: {
    status: 'pending' | 'synced' | 'failed';
    journalRef?: string;
    syncedAt?: Date;
    error?: string | null;
  },
) {
  const base = {
    provider: providerName,
    entryType: entry.entryType,
    amount: entry.amount,
    lines: entry.lines as unknown as Prisma.InputJsonValue,
    journalRef: patch.journalRef ?? null,
    status: patch.status,
    syncedAt: patch.syncedAt ?? null,
    error: patch.error ?? null,
  };
  try {
    await prisma.accountingEntry.upsert({
      where: {
        tenantId_entityType_entityId: {
          tenantId,
          entityType: entry.entityType,
          entityId: entry.entityId,
        },
      },
      create: {
        tenantId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        ...base,
      },
      update: base,
    });
  } catch (e) {
    // A concurrent sync may have inserted the same (tenant,entityType,entityId) → treat as a no-op
    // skip rather than crash (the other writer's row stands). Idempotency is preserved.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
    throw e;
  }
}

// ─────────────────────────── GET /accounting/entries ───────────────────────────
export async function listEntries(q: ListEntriesQuery) {
  const where: Prisma.AccountingEntryWhereInput = {};
  if (q.status) where.status = q.status;
  if (q.type) where.entryType = q.type;

  const [rows, total] = await Promise.all([
    prisma.accountingEntry.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.accountingEntry.count({ where }),
  ]);
  return { rows: rows.map(serializeEntry), total };
}
