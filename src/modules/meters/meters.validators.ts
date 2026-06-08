import { z } from 'zod';

export const meterTypeEnum = z.enum(['electricity', 'water']);

/**
 * Create a meter reading for a room. PRD §6.17 / US-04.
 *  - `previousReading` is NOT accepted from the client — the server auto-derives it from the
 *    most recent prior reading for the same room+type (0 if first).
 *  - `pricePerUnit` is optional: for electricity it defaults to property.electricityPriceKwh;
 *    for water it is REQUIRED (no default price exists).
 *  - `photoKey` is REQUIRED (PRD: "foto meteran wajib") → missing ⇒ 422.
 */
export const createMeterReadingSchema = z.object({
  type: meterTypeEnum.default('electricity'),
  currentReading: z.number().nonnegative(),
  periodMonth: z.number().int().min(1).max(12),
  periodYear: z.number().int().min(2000).max(2100),
  pricePerUnit: z.number().nonnegative().optional(),
  photoKey: z.string().min(1, 'photoKey is required (foto meteran wajib)'),
  notes: z.string().max(1000).optional(),
});

/** Correct an existing reading. currentReading and/or pricePerUnit recompute usage+amount. */
export const updateMeterReadingSchema = z
  .object({
    currentReading: z.number().nonnegative().optional(),
    pricePerUnit: z.number().nonnegative().optional(),
    photoKey: z.string().min(1).optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field must be provided' });

export const listMeterReadingQuery = z.object({
  type: meterTypeEnum.optional(),
  period_month: z.coerce.number().int().min(1).max(12).optional(),
  period_year: z.coerce.number().int().min(2000).max(2100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateMeterReadingInput = z.infer<typeof createMeterReadingSchema>;
export type UpdateMeterReadingInput = z.infer<typeof updateMeterReadingSchema>;
export type ListMeterReadingQuery = z.infer<typeof listMeterReadingQuery>;
