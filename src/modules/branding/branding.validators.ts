import { z } from 'zod';

/**
 * White-label branding (PRD Modul 23 — Premium). The PUT body lets an Owner set/clear the three
 * branding fields. All keys are OPTIONAL (partial update); `null` explicitly CLEARS a field:
 *   - brandName  : display-name override (1..60 chars) or null to clear (→ falls back to tenant.name)
 *   - brandColor : `#RRGGBB` hex (validated) or null to clear (→ falls back to default theme)
 *   - logoKey    : an uploaded file key (purpose `logo`) or null to clear the logo
 *
 * `.strict()` rejects unknown keys (e.g. a client trying to smuggle tenantId) → 422.
 * An EMPTY body ({}) is allowed and is a no-op (returns current branding).
 *
 * Custom domain is DEFERRED — there is intentionally NO `brandDomain` field here.
 */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const updateBrandingSchema = z
  .object({
    brandName: z.string().trim().min(1).max(60).nullable().optional(),
    brandColor: z
      .string()
      .regex(HEX_COLOR_RE, 'brandColor must be a hex color in the form #RRGGBB')
      .nullable()
      .optional(),
    logoKey: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .strict();

export type UpdateBrandingInput = z.infer<typeof updateBrandingSchema>;
