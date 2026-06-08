import { z } from 'zod';

export const propertyTypeEnum = z.enum(['putra', 'putri', 'campur']);
export const lateFeeTypeEnum = z.enum(['flat', 'percentage']);

export const createPropertySchema = z.object({
  name: z.string().min(2).max(150),
  type: propertyTypeEnum.default('campur'),
  address: z.string().min(2),
  city: z.string().min(1),
  province: z.string().min(1),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  facilities: z.array(z.string()).optional(),
  billingDay: z.number().int().min(1).max(28).optional(),
  lateFeeType: lateFeeTypeEnum.optional(),
  lateFeeValue: z.number().min(0).optional(),
  lateFeeGraceDays: z.number().int().min(0).max(60).optional(),
  electricityPriceKwh: z.number().min(0).optional(),
});

export const updatePropertySchema = createPropertySchema.partial().extend({
  name: z.string().min(2).max(150),
  type: propertyTypeEnum,
  address: z.string().min(2),
  city: z.string().min(1),
  province: z.string().min(1),
});

export const listPropertyQuery = z.object({
  type: propertyTypeEnum.optional(),
  city: z.string().optional(),
  is_active: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_by: z.string().optional(),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type CreatePropertyInput = z.infer<typeof createPropertySchema>;
export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>;
export type ListPropertyQuery = z.infer<typeof listPropertyQuery>;
