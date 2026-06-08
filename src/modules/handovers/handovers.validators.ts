import { z } from 'zod';

export const handoverTypeEnum = z.enum(['checkin', 'checkout']);
export const inventoryConditionEnum = z.enum(['good', 'damaged', 'missing']);

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** A single inventory line on the berita acara. */
export const inventoryItemSchema = z.object({
  item: z.string().min(1, 'item is required').max(200),
  condition: inventoryConditionEnum,
  notes: z.string().max(1000).optional(),
});

/**
 * Create a handover (berita acara). PRD §6.5.
 *  - `type` gates the role at the route layer (checkin = Admin+, checkout = Manager+).
 *  - `photoKeys` are file keys (presigned to URLs on read).
 *  - `initialMeterElectricity` is checkin-only; on checkout it is ignored.
 */
export const createHandoverSchema = z.object({
  type: handoverTypeEnum,
  date: dateString,
  photoKeys: z.array(z.string().min(1)).max(50).default([]),
  inventory: z.array(inventoryItemSchema).max(200).default([]),
  initialMeterElectricity: z.number().nonnegative().optional(),
  signatureKey: z.string().min(1).optional(),
  notes: z.string().max(2000).optional(),
});

export const listHandoversByResidentQuery = z.object({
  type: handoverTypeEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type CreateHandoverInput = z.infer<typeof createHandoverSchema>;
export type ListHandoversByResidentQuery = z.infer<typeof listHandoversByResidentQuery>;
