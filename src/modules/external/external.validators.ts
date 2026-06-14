import { z } from 'zod';

/**
 * Query validators for the Public API (PRD Modul 22). Standard pagination + a small, safe set of
 * filters per resource. Unknown keys are ignored (Zod strips them). All list endpoints share the
 * page/limit/sort_order base.
 */
const base = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
};

export const extListQuery = z.object({ ...base });

export const extRoomListQuery = z.object({
  ...base,
  property_id: z.string().uuid().optional(),
  status: z.enum(['empty', 'occupied', 'booking', 'maintenance', 'renovation']).optional(),
  room_type: z.string().optional(),
});

export const extResidentListQuery = z.object({
  ...base,
  status: z.enum(['active', 'inactive', 'alumni']).optional(),
  property_id: z.string().uuid().optional(),
  room_id: z.string().uuid().optional(),
  q: z.string().optional(),
});

export const extInvoiceListQuery = z.object({
  ...base,
  status: z.enum(['unpaid', 'partial', 'paid', 'overdue', 'cancelled']).optional(),
  property_id: z.string().uuid().optional(),
  resident_id: z.string().uuid().optional(),
  period_month: z.coerce.number().int().min(1).max(12).optional(),
  period_year: z.coerce.number().int().min(2000).max(2100).optional(),
  overdue: z.coerce.boolean().optional(),
});

export const extBookingListQuery = z.object({
  ...base,
  status: z.enum(['pending', 'confirmed', 'converted', 'cancelled', 'expired']).optional(),
  property_id: z.string().uuid().optional(),
  room_id: z.string().uuid().optional(),
});

export type ExtListQuery = z.infer<typeof extListQuery>;
export type ExtRoomListQuery = z.infer<typeof extRoomListQuery>;
export type ExtResidentListQuery = z.infer<typeof extResidentListQuery>;
export type ExtInvoiceListQuery = z.infer<typeof extInvoiceListQuery>;
export type ExtBookingListQuery = z.infer<typeof extBookingListQuery>;
