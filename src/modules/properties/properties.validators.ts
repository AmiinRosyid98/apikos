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
  // Acquisition / total investment cost for the ROI report. Nullable (pass null to clear).
  investmentValue: z.number().min(0).max(99_999_999_999.99).nullable().optional(),
});

export const updatePropertySchema = createPropertySchema.partial().extend({
  name: z.string().min(2).max(150),
  type: propertyTypeEnum,
  address: z.string().min(2),
  city: z.string().min(1),
  province: z.string().min(1),
});

/**
 * Public landing/booking-link management (PRD §6.2, §6.13). Owner/Manager set or clear the
 * marketing slug and toggle whether the public endpoints serve this property. Slug format is
 * `^[a-z0-9-]{3,100}$` (lowercase letters, digits, hyphen). At least one field must be present.
 * Pass `publicSlug: null` to CLEAR the slug (which also implies the property becomes unreachable).
 */
export const publicSettingsSchema = z
  .object({
    publicSlug: z
      .string()
      .regex(/^[a-z0-9-]{3,100}$/, 'Slug must be 3-100 chars of lowercase letters, digits, or hyphens')
      .nullable()
      .optional(),
    publicEnabled: z.boolean().optional(),
  })
  .refine((v) => v.publicSlug !== undefined || v.publicEnabled !== undefined, {
    message: 'Provide publicSlug and/or publicEnabled',
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
export type PublicSettingsInput = z.infer<typeof publicSettingsSchema>;
export type ListPropertyQuery = z.infer<typeof listPropertyQuery>;
