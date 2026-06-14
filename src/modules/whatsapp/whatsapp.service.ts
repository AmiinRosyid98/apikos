import { Prisma, type WaTemplateType, type WaMessageStatus } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { iso } from '../../utils/serialize';
import { waQuotaForPlan } from '../../services/plan.service';
import { getWhatsAppProvider } from './providers/factory';
import {
  DEFAULT_TEMPLATES,
  renderTemplate,
  formatRupiah,
  formatTanggal,
  type TemplateVars,
} from './whatsapp.templates';
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  ListTemplateQuery,
  BroadcastInput,
  ListLogsQuery,
} from './whatsapp.validators';

type TemplateRow = Prisma.WaTemplateGetPayload<object>;
type MessageRow = Prisma.WaMessageGetPayload<object>;

// ──────────────────────────────────────────────────────────────────────────────────────────
// Reminder config (PRD §6.10) — default applied in code when property.reminderConfig is null.
// ──────────────────────────────────────────────────────────────────────────────────────────
export interface ReminderConfig {
  enabled: boolean;
  offsets: { h7: boolean; h3: boolean; h0: boolean; h3plus: boolean; h7plus: boolean };
  contractExpiry: { h30: boolean; h14: boolean; h7: boolean };
}

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  enabled: true,
  offsets: { h7: true, h3: true, h0: true, h3plus: true, h7plus: true },
  contractExpiry: { h30: true, h14: true, h7: true },
};

/** Merge a stored (partial) reminderConfig JSON over the defaults. Null → defaults. */
export function resolveReminderConfig(stored: unknown): ReminderConfig {
  const s = (stored ?? {}) as Partial<ReminderConfig>;
  return {
    enabled: s.enabled ?? DEFAULT_REMINDER_CONFIG.enabled,
    offsets: { ...DEFAULT_REMINDER_CONFIG.offsets, ...(s.offsets ?? {}) },
    contractExpiry: { ...DEFAULT_REMINDER_CONFIG.contractExpiry, ...(s.contractExpiry ?? {}) },
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Serializers
// ──────────────────────────────────────────────────────────────────────────────────────────
export function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id,
    propertyId: t.propertyId,
    type: t.type,
    name: t.name,
    body: t.body,
    isActive: t.isActive,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export function serializeMessage(m: MessageRow) {
  return {
    id: m.id,
    propertyId: m.propertyId,
    residentId: m.residentId,
    invoiceId: m.invoiceId,
    toPhone: m.toPhone,
    toName: m.toName,
    templateType: m.templateType,
    reminderKey: m.reminderKey,
    body: m.body,
    status: m.status,
    provider: m.provider,
    providerMessageId: m.providerMessageId,
    error: m.error,
    sentByUserId: m.sentByUserId,
    createdAt: iso(m.createdAt),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Quota (PRD §12.2). Monthly count of messages with status in (sent|stub) vs plan limit.
// ──────────────────────────────────────────────────────────────────────────────────────────
export interface QuotaInfo {
  used: number;
  limit: number | null; // null = unlimited
  remaining: number | null; // null = unlimited
  periodMonth: number;
  periodYear: number;
}

/** Count this calendar month's "counted" messages (sent|stub) for the tenant. */
export async function getQuota(tenantId: string, asOf = new Date()): Promise<QuotaInfo> {
  const periodMonth = asOf.getMonth() + 1;
  const periodYear = asOf.getFullYear();
  const start = new Date(periodYear, periodMonth - 1, 1);
  const end = new Date(periodYear, periodMonth, 1);

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionPlan: true },
  });
  if (!tenant) throw Errors.notFound('Tenant not found');
  const limit = waQuotaForPlan(tenant.subscriptionPlan);

  const used = await prisma.waMessage.count({
    where: { status: { in: ['sent', 'stub'] }, createdAt: { gte: start, lt: end } },
  });

  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    periodMonth,
    periodYear,
  };
}

/** Throw PLAN_LIMIT_EXCEEDED (403) when sending `count` more messages would exceed the quota. */
export async function assertQuota(tenantId: string, count = 1, asOf = new Date()): Promise<void> {
  const q = await getQuota(tenantId, asOf);
  if (q.limit === null) return; // unlimited
  if (q.used + count > q.limit) {
    throw Errors.planLimit(
      `WhatsApp monthly quota reached (${q.used}/${q.limit}). Upgrade your plan to send more.`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Template resolution + rendering
// ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * Resolve the effective template body for a (type, propertyId): a property-specific template wins,
 * then a tenant default (propertyId null), then the built-in DEFAULT_TEMPLATES fallback. Only
 * active templates are used. Returns the body string.
 */
export async function resolveTemplateBody(
  type: Exclude<WaTemplateType, 'custom' | 'broadcast'>,
  propertyId: string | null,
): Promise<string> {
  const candidates = await prisma.waTemplate.findMany({
    where: {
      type,
      isActive: true,
      ...(propertyId
        ? { OR: [{ propertyId }, { propertyId: null }] }
        : { propertyId: null }),
    },
  });
  // Prefer the property-specific row over the tenant default.
  const specific = candidates.find((c) => c.propertyId === propertyId && propertyId !== null);
  const fallback = candidates.find((c) => c.propertyId === null);
  const chosen = specific ?? fallback;
  if (chosen) return chosen.body;
  return DEFAULT_TEMPLATES[type].body;
}

export interface RenderContext {
  residentName?: string | null;
  roomNumber?: string | null;
  invoiceAmount?: number | null;
  dueDate?: Date | string | null;
  propertyName?: string | null;
}

export function buildVars(ctx: RenderContext): TemplateVars {
  return {
    nama_penyewa: ctx.residentName ?? '-',
    nomor_kamar: ctx.roomNumber ?? '-',
    jumlah_tagihan:
      ctx.invoiceAmount !== null && ctx.invoiceAmount !== undefined
        ? formatRupiah(ctx.invoiceAmount)
        : '-',
    jatuh_tempo: formatTanggal(ctx.dueDate ?? null),
    nama_kos: ctx.propertyName ?? '-',
  };
}

/** Public render helper: substitute a template body against a resident/invoice/property context. */
export function renderForContext(body: string, ctx: RenderContext): string {
  return renderTemplate(body, buildVars(ctx));
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// THE single send path. Every caller (invoice send, broadcast, reminder cron) goes through here
// → provider. Records exactly one wa_messages row. In stub mode the row is status `stub`.
// ──────────────────────────────────────────────────────────────────────────────────────────
export interface SendParams {
  tenantId: string;
  toPhone: string;
  body: string;
  toName?: string | null;
  propertyId?: string | null;
  residentId?: string | null;
  invoiceId?: string | null;
  templateType?: WaTemplateType | null;
  reminderKey?: string | null;
  sentByUserId?: string | null;
}

/**
 * Send one message via the configured provider and log it. Returns the persisted wa_messages row.
 * The provider's 'sent' maps to row status `stub` when the StubProvider is active (demo mode) and
 * `sent` when a real provider is active; a provider failure maps to `failed`.
 *
 * NOTE: quota is enforced by the CALLER before calling this (so broadcast can do one batch check).
 */
export async function sendViaProvider(params: SendParams): Promise<MessageRow> {
  const provider = getWhatsAppProvider();
  const result = await provider.send(params.toPhone, params.body);

  let status: WaMessageStatus;
  if (result.status === 'failed') status = 'failed';
  else status = provider.name === 'stub' ? 'stub' : 'sent';

  return prisma.waMessage.create({
    data: {
      tenantId: params.tenantId,
      propertyId: params.propertyId ?? null,
      residentId: params.residentId ?? null,
      invoiceId: params.invoiceId ?? null,
      toPhone: params.toPhone,
      toName: params.toName ?? null,
      templateType: params.templateType ?? null,
      reminderKey: params.reminderKey ?? null,
      body: params.body,
      status,
      provider: provider.name,
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ?? null,
      sentByUserId: params.sentByUserId ?? null,
    },
  });
}

/**
 * Seed the tenant-default templates (propertyId null) for every non-custom type, if missing.
 * Idempotent — skips types that already have a default. Called by the seed; can also be called
 * lazily so tenants created via registration get sensible defaults on first use.
 */
export async function ensureDefaultTemplates(tenantId: string): Promise<number> {
  let created = 0;
  for (const type of Object.keys(DEFAULT_TEMPLATES) as (keyof typeof DEFAULT_TEMPLATES)[]) {
    const exists = await prisma.waTemplate.findFirst({
      where: { type: type as WaTemplateType, propertyId: null },
    });
    if (exists) continue;
    try {
      await prisma.waTemplate.create({
        data: {
          tenantId,
          propertyId: null,
          type: type as WaTemplateType,
          name: DEFAULT_TEMPLATES[type].name,
          body: DEFAULT_TEMPLATES[type].body,
          isActive: true,
        },
      });
      created++;
    } catch (e) {
      // Idempotent under races (unique tenant/property/type).
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }
  return created;
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Templates CRUD
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function listTemplates(q: ListTemplateQuery, scope: string[] | undefined) {
  const where: Prisma.WaTemplateWhereInput = {};
  if (q.type) where.type = q.type;
  if (q.property_id) where.propertyId = q.property_id;
  // Property-scope: restricted users see tenant-default (null property) + their allowed properties.
  if (scope !== undefined) {
    if (q.property_id) {
      where.propertyId = scope.includes(q.property_id) ? q.property_id : '__none__';
    } else {
      where.OR = [{ propertyId: null }, { propertyId: { in: scope } }];
    }
  }

  const [rows, total] = await Promise.all([
    prisma.waTemplate.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.waTemplate.count({ where }),
  ]);
  return { rows: rows.map(serializeTemplate), total };
}

async function getTemplate(id: string): Promise<TemplateRow> {
  const t = await prisma.waTemplate.findFirst({ where: { id } });
  if (!t) throw Errors.notFound('Template not found');
  return t;
}

export async function getTemplatePropertyId(id: string): Promise<string | null> {
  return (await getTemplate(id)).propertyId;
}

export async function createTemplate(tenantId: string, input: CreateTemplateInput) {
  // Validate property exists (and is in tenant) when provided.
  if (input.propertyId) {
    const prop = await prisma.property.findFirst({ where: { id: input.propertyId } });
    if (!prop) throw Errors.notFound('Property not found');
  }
  try {
    const created = await prisma.waTemplate.create({
      data: {
        tenantId,
        propertyId: input.propertyId ?? null,
        type: input.type,
        name: input.name,
        body: input.body,
        isActive: input.isActive,
      },
    });
    return serializeTemplate(created);
  } catch (e) {
    // Unique (tenant, property, type) collision for non-custom types.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw Errors.conflict(
        `A '${input.type}' template already exists for this scope. Edit it instead, or use type 'custom'.`,
      );
    }
    throw e;
  }
}

export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  await getTemplate(id);
  const updated = await prisma.waTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
  return serializeTemplate(updated);
}

export async function deleteTemplate(id: string) {
  await getTemplate(id);
  await prisma.waTemplate.delete({ where: { id } });
  return { id, deleted: true };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Send an invoice via WA (PRD §6.9 — /invoices/:id/send-wa)
// ──────────────────────────────────────────────────────────────────────────────────────────
/** Load the invoice's property for the property-scope check (controller calls this). */
export async function getInvoicePropertyIdForWa(invoiceId: string): Promise<string> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    select: { propertyId: true },
  });
  if (!inv) throw Errors.notFound('Invoice not found');
  return inv.propertyId;
}

export async function sendInvoiceWa(
  tenantId: string,
  invoiceId: string,
  templateType: 'invoice_new' | 'reminder_due',
  sentByUserId: string,
) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    include: { resident: true, property: true, room: true },
  });
  if (!invoice) throw Errors.notFound('Invoice not found');
  if (!invoice.resident.phone) {
    throw Errors.validation('Resident has no phone number on file');
  }

  // Enforce quota (counts sent|stub this month) BEFORE sending.
  await assertQuota(tenantId, 1);

  const body = renderForContext(await resolveTemplateBody(templateType, invoice.propertyId), {
    residentName: invoice.resident.fullName,
    roomNumber: invoice.room?.roomNumber ?? null,
    invoiceAmount: Number(invoice.totalAmount),
    dueDate: invoice.dueDate,
    propertyName: invoice.property.name,
  });

  const msg = await sendViaProvider({
    tenantId,
    toPhone: invoice.resident.phone,
    toName: invoice.resident.fullName,
    body,
    propertyId: invoice.propertyId,
    residentId: invoice.residentId,
    invoiceId: invoice.id,
    templateType,
    sentByUserId,
  });
  return serializeMessage(msg);
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Broadcast (PRD §6.9 — /wa/broadcast). Sends a rendered message to each ACTIVE resident of the
// property. Quota: blocks the whole batch when remaining < recipients (no partial) — documented.
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function broadcast(
  tenantId: string,
  input: BroadcastInput,
  sentByUserId: string,
) {
  const property = await prisma.property.findFirst({ where: { id: input.propertyId } });
  if (!property) throw Errors.notFound('Property not found');

  const residents = await prisma.resident.findMany({
    where: { propertyId: input.propertyId, status: 'active' },
    include: { room: true },
  });
  const recipients = residents.filter((r) => r.phone && r.phone.trim().length > 0);

  if (recipients.length === 0) {
    return { sent: 0, recipients: 0, messages: [] as ReturnType<typeof serializeMessage>[] };
  }

  // Quota: block the whole batch if it would exceed (all-or-nothing for a broadcast).
  await assertQuota(tenantId, recipients.length);

  const messages: ReturnType<typeof serializeMessage>[] = [];
  for (const r of recipients) {
    const body = renderForContext(input.body, {
      residentName: r.fullName,
      roomNumber: r.room?.roomNumber ?? null,
      invoiceAmount: null,
      dueDate: null,
      propertyName: property.name,
    });
    const msg = await sendViaProvider({
      tenantId,
      toPhone: r.phone,
      toName: r.fullName,
      body,
      propertyId: input.propertyId,
      residentId: r.id,
      templateType: 'broadcast',
      sentByUserId,
    });
    messages.push(serializeMessage(msg));
  }
  return { sent: messages.length, recipients: recipients.length, messages };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Logs (PRD §6.9 — /wa/logs)
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function listLogs(q: ListLogsQuery, scope: string[] | undefined) {
  const where: Prisma.WaMessageWhereInput = {};
  if (q.status) where.status = q.status;
  if (q.property_id) where.propertyId = q.property_id;
  if (q.date_from || q.date_to) {
    where.createdAt = {};
    if (q.date_from) where.createdAt.gte = new Date(`${q.date_from}T00:00:00.000Z`);
    if (q.date_to) where.createdAt.lte = new Date(`${q.date_to}T23:59:59.999Z`);
  }
  if (scope !== undefined) {
    if (q.property_id) {
      where.propertyId = scope.includes(q.property_id) ? q.property_id : '__none__';
    } else {
      // Restricted users see their properties' messages (tenant-null property messages excluded).
      where.propertyId = { in: scope };
    }
  }

  const [rows, total] = await Promise.all([
    prisma.waMessage.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.waMessage.count({ where }),
  ]);
  return { rows: rows.map(serializeMessage), total };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Status / quota (PRD §6.9 — /wa/status)
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function getStatus(tenantId: string) {
  const provider = getWhatsAppProvider();
  const quota = await getQuota(tenantId);
  return {
    provider: provider.name,
    configured: provider.name === 'fonnte',
    quota: {
      used: quota.used,
      limit: quota.limit,
      remaining: quota.remaining,
      periodMonth: quota.periodMonth,
      periodYear: quota.periodYear,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Reminder config (PRD §6.10 — /properties/:id/reminder-config)
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function getReminderConfig(propertyId: string): Promise<ReminderConfig> {
  const prop = await prisma.property.findFirst({
    where: { id: propertyId },
    select: { reminderConfig: true },
  });
  if (!prop) throw Errors.notFound('Property not found');
  return resolveReminderConfig(prop.reminderConfig);
}

export async function updateReminderConfig(
  propertyId: string,
  patch: Partial<ReminderConfig>,
): Promise<ReminderConfig> {
  const prop = await prisma.property.findFirst({
    where: { id: propertyId },
    select: { reminderConfig: true },
  });
  if (!prop) throw Errors.notFound('Property not found');

  // Merge the patch over the currently-resolved config so a partial update keeps prior values.
  const current = resolveReminderConfig(prop.reminderConfig);
  const merged: ReminderConfig = {
    enabled: patch.enabled ?? current.enabled,
    offsets: { ...current.offsets, ...(patch.offsets ?? {}) },
    contractExpiry: { ...current.contractExpiry, ...(patch.contractExpiry ?? {}) },
  };
  await prisma.property.update({
    where: { id: propertyId },
    data: { reminderConfig: merged as unknown as Prisma.InputJsonValue },
  });
  return merged;
}
