import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, iso } from '../../utils/serialize';
import { presignDownloadIfExists } from '../files/files.service';
import { ensureCategoryByName, createExpense } from '../finance/finance.service';
import { notify } from '../../services/notification.service';
import type {
  CreateTicketInput,
  UpdateTicketInput,
  TicketStatusInput,
  ListTicketQuery,
  CreateVendorInput,
  UpdateVendorInput,
  ListVendorQuery,
  RoomMaintenanceQuery,
} from './maintenance.validators';

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type TicketRow = Prisma.MaintenanceTicketGetPayload<object>;
type VendorRow = Prisma.VendorGetPayload<object>;

/** The Finance category cost→expense logs into (a seeded default — PRD §6.14 "biaya"). */
export const MAINTENANCE_EXPENSE_CATEGORY = 'Maintenance';

/**
 * Allowed status transitions (PRD §6.14). `done` and `cancelled` are terminal — no transition out.
 * `cancelled` is reachable from any non-terminal state. Anything not listed → 409 CONFLICT.
 */
const TRANSITIONS: Record<TicketRow['status'], TicketRow['status'][]> = {
  open: ['in_progress', 'waiting_parts', 'done', 'cancelled'],
  in_progress: ['waiting_parts', 'done', 'cancelled'],
  waiting_parts: ['in_progress', 'done', 'cancelled'],
  done: [],
  cancelled: [],
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────── Serializers ───────────────────────────
export function serializeTicket(t: TicketRow) {
  return {
    id: t.id,
    propertyId: t.propertyId,
    roomId: t.roomId,
    ticketNumber: t.ticketNumber,
    title: t.title,
    description: t.description,
    category: t.category,
    priority: t.priority,
    status: t.status,
    vendorId: t.vendorId,
    photoKeys: (t.photoKeys as string[]) ?? [],
    cost: dec(t.cost),
    reportedByUserId: t.reportedByUserId,
    resolvedAt: iso(t.resolvedAt),
    expenseId: t.expenseId,
    notes: t.notes,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export function serializeVendor(v: VendorRow) {
  return {
    id: v.id,
    name: v.name,
    skill: v.skill,
    phone: v.phone,
    rating: dec(v.rating),
    notes: v.notes,
    isActive: v.isActive,
    createdAt: iso(v.createdAt),
    updatedAt: iso(v.updatedAt),
  };
}

// ─────────────────────────── Ticket numbering (TKT-{YEAR}-{SEQ}) ───────────────────────────
/**
 * Per-tenant sequential ticket numbering (mirrors the invoice numbering pattern — A8/fix h).
 * Uses the tenant_counters.maintenanceSeq/maintenanceSeqYear columns, updated atomically inside
 * the same transaction as the ticket insert so seqs never collide or gap within a tenant.
 */
async function nextTicketNumber(tx: TxClient, tenantId: string, year: number): Promise<string> {
  const counter = await tx.tenantCounter.findUnique({ where: { tenantId } });
  let seq: number;
  if (!counter) {
    await tx.tenantCounter.create({
      data: { tenantId, maintenanceSeqYear: year, maintenanceSeq: 1 },
    });
    seq = 1;
  } else if (counter.maintenanceSeqYear !== year) {
    await tx.tenantCounter.update({
      where: { tenantId },
      data: { maintenanceSeqYear: year, maintenanceSeq: 1 },
    });
    seq = 1;
  } else {
    const updated = await tx.tenantCounter.update({
      where: { tenantId },
      data: { maintenanceSeq: { increment: 1 } },
    });
    seq = updated.maintenanceSeq;
  }
  return `TKT-${year}-${String(seq).padStart(4, '0')}`;
}

// ─────────────────────────── Lookups ───────────────────────────
async function getTicket(id: string): Promise<TicketRow> {
  const t = await prisma.maintenanceTicket.findFirst({ where: { id } });
  if (!t) throw Errors.notFound('Maintenance ticket not found');
  return t;
}

/** Resolve the property a ticket belongs to (for property-scope access checks). */
export async function getTicketPropertyId(id: string): Promise<string> {
  return (await getTicket(id)).propertyId;
}

async function getVendor(id: string): Promise<VendorRow> {
  const v = await prisma.vendor.findFirst({ where: { id } });
  if (!v) throw Errors.notFound('Vendor not found');
  return v;
}

// ─────────────────────────── Tickets ───────────────────────────
export async function listTickets(q: ListTicketQuery, scope: string[] | undefined) {
  const where: Prisma.MaintenanceTicketWhereInput = {};
  if (q.status) where.status = q.status;
  if (q.priority) where.priority = q.priority;
  if (q.room_id) where.roomId = q.room_id;
  if (q.vendor_id) where.vendorId = q.vendor_id;
  if (q.property_id) where.propertyId = q.property_id;
  // Property-scope restriction (manager/admin/finance limited to user_property_access).
  if (scope !== undefined) {
    where.propertyId =
      q.property_id && scope.includes(q.property_id)
        ? q.property_id
        : { in: q.property_id ? ['__none__'] : scope };
  }

  const [rows, total] = await Promise.all([
    prisma.maintenanceTicket.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.maintenanceTicket.count({ where }),
  ]);
  return { rows: rows.map(serializeTicket), total };
}

/** Ticket detail with presigned photoKeys + the assigned vendor (if any). */
export async function getTicketDetail(id: string) {
  const t = await getTicket(id);
  const [photos, vendor] = await Promise.all([
    Promise.all(
      ((t.photoKeys as string[]) ?? []).map(async (key) => ({
        key,
        url: await presignDownloadIfExists(key),
      })),
    ),
    t.vendorId ? prisma.vendor.findFirst({ where: { id: t.vendorId } }) : Promise.resolve(null),
  ]);

  return {
    ...serializeTicket(t),
    photos,
    vendor: vendor ? serializeVendor(vendor) : null,
  };
}

/**
 * Create a ticket → status `open`, sequential ticketNumber. `roomId` null = area umum/common.
 * If a room is given it must belong to the property (else 422).
 */
export async function createTicket(tenantId: string, userId: string, input: CreateTicketInput) {
  const property = await prisma.property.findFirst({ where: { id: input.propertyId } });
  if (!property) throw Errors.notFound('Property not found');

  let roomNumber: string | null = null;
  if (input.roomId) {
    const room = await prisma.room.findFirst({ where: { id: input.roomId } });
    if (!room) throw Errors.notFound('Room not found');
    if (room.propertyId !== input.propertyId) {
      throw Errors.validation('Room does not belong to the given property');
    }
    roomNumber = room.roomNumber;
  }

  const year = new Date().getUTCFullYear();
  const created = await prisma.$transaction(async (tx) => {
    const ticketNumber = await nextTicketNumber(tx, tenantId, year);
    return tx.maintenanceTicket.create({
      data: {
        tenantId,
        propertyId: input.propertyId,
        roomId: input.roomId ?? null,
        ticketNumber,
        title: input.title,
        description: input.description,
        category: input.category,
        priority: input.priority,
        status: 'open',
        photoKeys: input.photoKeys,
        cost: 0,
        reportedByUserId: userId,
      },
    });
  });

  // Best-effort IN-APP maintenance_critical notification (PRD §6.18) — ONLY for critical-priority
  // tickets → owner/manager/admin. notify() is failure-isolated and never throws.
  if (created.priority === 'critical') {
    const location = roomNumber ? `kamar ${roomNumber}` : 'area umum';
    await notify({
      tenantId,
      type: 'maintenance_critical',
      title: 'Tiket maintenance kritis',
      body: `Tiket kritis ${created.ticketNumber}: ${created.title} (${location}).`,
      link: '/maintenance',
      entityType: 'maintenance_ticket',
      entityId: created.id,
    });
  }

  return serializeTicket(created);
}

/**
 * Edit a ticket (PRD §6.14): assign vendor (`vendorId`), set `cost`, update text/priority/photos.
 * If `cost>0` and `logAsExpense:true`, logs the cost as a Finance "Maintenance" expense (seam) —
 * once only (guarded by `expenseId`). Returns the (re-read) ticket.
 */
export async function updateTicket(
  tenantId: string,
  userId: string,
  id: string,
  input: UpdateTicketInput,
) {
  const ticket = await getTicket(id);

  if (input.vendorId) {
    // Validate the vendor belongs to the tenant (findFirst is tenant-scoped).
    await getVendor(input.vendorId);
  }

  const data: Prisma.MaintenanceTicketUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.category !== undefined) data.category = input.category;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.vendorId !== undefined) {
    data.vendor = input.vendorId ? { connect: { id: input.vendorId } } : { disconnect: true };
  }
  if (input.cost !== undefined) data.cost = input.cost;
  if (input.photoKeys !== undefined) data.photoKeys = input.photoKeys;
  if (input.notes !== undefined) data.notes = input.notes;

  await prisma.maintenanceTicket.update({ where: { id }, data });

  // cost→expense seam (optional, default off).
  const effectiveCost = input.cost !== undefined ? input.cost : Number(ticket.cost);
  if (input.logAsExpense && effectiveCost > 0) {
    await logTicketCostAsExpense(tenantId, userId, id);
  }

  return getTicketDetail(id);
}

/**
 * Status transition (PRD §6.14). Validates the transition (invalid → 409, incl. any change on a
 * cancelled/done terminal ticket). On `done` sets `resolvedAt`. Optionally sets `cost` and logs
 * the cost→expense (when `logAsExpense` + cost>0), typically on close.
 */
export async function changeStatus(
  tenantId: string,
  userId: string,
  id: string,
  input: TicketStatusInput,
) {
  const ticket = await getTicket(id);

  if (ticket.status === input.status) {
    throw Errors.conflict(`Ticket is already '${input.status}'`);
  }
  const allowed = TRANSITIONS[ticket.status];
  if (!allowed.includes(input.status)) {
    throw Errors.conflict(
      `Invalid status transition '${ticket.status}' → '${input.status}'`,
    );
  }

  const data: Prisma.MaintenanceTicketUpdateInput = { status: input.status };
  if (input.cost !== undefined) data.cost = input.cost;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.status === 'done') data.resolvedAt = new Date();

  await prisma.maintenanceTicket.update({ where: { id }, data });

  const effectiveCost = input.cost !== undefined ? input.cost : Number(ticket.cost);
  if (input.logAsExpense && effectiveCost > 0) {
    await logTicketCostAsExpense(tenantId, userId, id);
  }

  return getTicketDetail(id);
}

/**
 * COST → EXPENSE SEAM (optional, documented, default off). Creates a Finance `expenses` row in the
 * seeded "Maintenance" category for the ticket's cost, scoped to the ticket's property, via the
 * EXISTING finance/expense service (so all expense conventions — tenant scope, audit-free service
 * layer, serialization — are reused). Idempotent: a ticket records its `expenseId` after the first
 * log and will not double-log. No-op if cost is 0.
 */
async function logTicketCostAsExpense(tenantId: string, userId: string, ticketId: string) {
  const ticket = await getTicket(ticketId);
  const cost = round2(Number(ticket.cost));
  if (cost <= 0) return;
  if (ticket.expenseId) return; // already logged — never double-log

  const categoryId = await ensureCategoryByName(tenantId, MAINTENANCE_EXPENSE_CATEGORY);
  const today = new Date().toISOString().slice(0, 10);
  const expense = await createExpense(tenantId, userId, {
    propertyId: ticket.propertyId,
    categoryId,
    amount: cost,
    date: today,
    description: `${ticket.ticketNumber}: ${ticket.title}`,
  });
  await prisma.maintenanceTicket.update({
    where: { id: ticketId },
    data: { expenseId: expense.id },
  });
}

// ─────────────────────────── Per-room history (PRD §6.14) ───────────────────────────
/** Tickets for a room (check-out reference). Mirrors GET /maintenance?room_id= but room-nested. */
export async function listTicketsByRoom(roomId: string, q: RoomMaintenanceQuery) {
  const where: Prisma.MaintenanceTicketWhereInput = { roomId };
  if (q.status) where.status = q.status;

  const [rows, total, costAgg] = await Promise.all([
    prisma.maintenanceTicket.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.maintenanceTicket.count({ where }),
    prisma.maintenanceTicket.aggregate({ where, _sum: { cost: true } }),
  ]);
  return {
    rows: rows.map(serializeTicket),
    total,
    totalCost: round2(Number(costAgg._sum.cost ?? 0)),
  };
}

// ─────────────────────────── Vendors ───────────────────────────
export async function listVendors(q: ListVendorQuery) {
  const where: Prisma.VendorWhereInput = {};
  if (q.skill) where.skill = { contains: q.skill, mode: 'insensitive' };
  if (q.is_active !== undefined) where.isActive = q.is_active;

  const [rows, total] = await Promise.all([
    prisma.vendor.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.vendor.count({ where }),
  ]);
  return { rows: rows.map(serializeVendor), total };
}

/** Vendor detail INCLUDING work history: assigned tickets + total cost + count (PRD §6.14). */
export async function getVendorDetail(id: string) {
  const vendor = await getVendor(id);
  const [tickets, agg] = await Promise.all([
    prisma.maintenanceTicket.findMany({
      where: { vendorId: id },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.maintenanceTicket.aggregate({
      where: { vendorId: id },
      _sum: { cost: true },
      _count: true,
    }),
  ]);
  return {
    ...serializeVendor(vendor),
    workHistory: {
      ticketCount: agg._count,
      totalCost: round2(Number(agg._sum.cost ?? 0)),
      tickets: tickets.map(serializeTicket),
    },
  };
}

export async function createVendor(tenantId: string, input: CreateVendorInput) {
  const created = await prisma.vendor.create({
    data: {
      tenantId,
      name: input.name,
      skill: input.skill,
      phone: input.phone,
      rating: input.rating,
      notes: input.notes,
      isActive: input.isActive,
    },
  });
  return serializeVendor(created);
}

export async function updateVendor(id: string, input: UpdateVendorInput) {
  await getVendor(id);
  const data: Prisma.VendorUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.skill !== undefined) data.skill = input.skill;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.rating !== undefined) data.rating = input.rating;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  const updated = await prisma.vendor.update({ where: { id }, data });
  return serializeVendor(updated);
}

/**
 * Delete a vendor (Manager+). DECISION: soft-deactivate if the vendor is referenced by any ticket
 * (preserve work history + the FK is SetNull so deleting would orphan tickets' assignee); else
 * hard-delete. Returns `{ id, deleted | deactivated }`.
 */
export async function deleteVendor(id: string): Promise<{ id: string; mode: 'deleted' | 'deactivated' }> {
  await getVendor(id);
  const refCount = await prisma.maintenanceTicket.count({ where: { vendorId: id } });
  if (refCount > 0) {
    await prisma.vendor.update({ where: { id }, data: { isActive: false } });
    return { id, mode: 'deactivated' };
  }
  await prisma.vendor.delete({ where: { id } });
  return { id, mode: 'deleted' };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// PUBLIC REPORT SEAM (deferred — INTERNAL maintenance only in this build, PRD §6.14 V1.1).
//
// A future public tenant-submitted-report link would add an UNAUTHENTICATED endpoint (e.g.
// POST /public/properties/:publicSlug/maintenance-reports) that resolves the tenant from
// Property.publicSlug and calls a thin wrapper over `createTicket` here — omitting reportedByUserId
// (or stamping a synthetic "resident report" source), forcing status `open`, and optionally
// capturing the reporting resident's room. The numbering, vendor assignment, status state machine,
// per-room history, and cost→expense seam above are all reusable as-is; only the entry point +
// the (untrusted) input source differ. Leave this comment as the single hook point.
// ──────────────────────────────────────────────────────────────────────────────────────────
