import { z } from 'zod';

export const maintenancePriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
export const maintenanceStatusEnum = z.enum([
  'open',
  'in_progress',
  'waiting_parts',
  'done',
  'cancelled',
]);

const photoKeys = z.array(z.string().min(1)).max(20).default([]);

// ─────────────────────────── Tickets ───────────────────────────

/**
 * Create a maintenance ticket (PRD §6.14). `roomId` omitted/null = area umum / common area.
 * `status` is always `open` on create (set in the service). `vendorId`/`cost` are set later via
 * PUT (assign + cost). `propertyId` is required; if `roomId` is given it must belong to it.
 */
export const createTicketSchema = z.object({
  propertyId: z.string().uuid(),
  roomId: z.string().uuid().nullable().optional(),
  title: z.string().min(2).max(200),
  description: z.string().min(1).max(5000),
  category: z.string().max(120).optional(),
  priority: maintenancePriorityEnum.default('medium'),
  photoKeys,
});

/**
 * Edit a ticket (PRD §6.14). Includes assigning a vendor (`vendorId`) and setting `cost`. All
 * fields optional (partial update). `vendorId:null` un-assigns. On a PUT with `cost>0` and
 * `logAsExpense:true`, the cost is logged as a Finance "Maintenance" expense (cost→expense seam).
 */
export const updateTicketSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().min(1).max(5000).optional(),
  category: z.string().max(120).nullable().optional(),
  priority: maintenancePriorityEnum.optional(),
  vendorId: z.string().uuid().nullable().optional(),
  cost: z.number().min(0).optional(),
  photoKeys: z.array(z.string().min(1)).max(20).optional(),
  notes: z.string().max(5000).nullable().optional(),
  logAsExpense: z.boolean().default(false),
});

/**
 * Status transition (PRD §6.14). Valid transitions enforced in the service. On `done` →
 * `resolvedAt` is set. `cancelled` allowed from any non-terminal state. Optional `cost` +
 * `logAsExpense` when closing (done) so a single call can close + log the expense.
 */
export const ticketStatusSchema = z.object({
  status: maintenanceStatusEnum,
  cost: z.number().min(0).optional(),
  logAsExpense: z.boolean().default(false),
  notes: z.string().max(5000).optional(),
});

export const listTicketQuery = z.object({
  status: maintenanceStatusEnum.optional(),
  priority: maintenancePriorityEnum.optional(),
  property_id: z.string().uuid().optional(),
  room_id: z.string().uuid().optional(),
  vendor_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

// ─────────────────────────── Vendors ───────────────────────────

export const createVendorSchema = z.object({
  name: z.string().min(2).max(150),
  skill: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  rating: z.number().min(1).max(5).optional(),
  notes: z.string().max(5000).optional(),
  isActive: z.boolean().default(true),
});

export const updateVendorSchema = z.object({
  name: z.string().min(2).max(150).optional(),
  skill: z.string().max(120).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  rating: z.number().min(1).max(5).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const listVendorQuery = z.object({
  skill: z.string().max(120).optional(),
  is_active: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

// Per-room history (GET /rooms/:id/maintenance) — pagination only.
export const roomMaintenanceQuery = z.object({
  status: maintenanceStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type TicketStatusInput = z.infer<typeof ticketStatusSchema>;
export type ListTicketQuery = z.infer<typeof listTicketQuery>;
export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
export type ListVendorQuery = z.infer<typeof listVendorQuery>;
export type RoomMaintenanceQuery = z.infer<typeof roomMaintenanceQuery>;
