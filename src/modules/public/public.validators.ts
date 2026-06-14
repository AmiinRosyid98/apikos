import { z } from 'zod';

/**
 * PUBLIC module validators (PRD §6.2 landing publik, §6.13 link booking publik). These guard
 * UNAUTHENTICATED input from the open internet, so they are deliberately strict and never accept
 * any tenant/property identifier from the body — the tenant + property are derived ONLY from the
 * URL slug.
 */

/** URL slug param: `^[a-z0-9-]{3,100}$` (same charset as the owner-side setter). */
export const slugParamSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]{3,100}$/, 'Invalid slug'),
});

/** YYYY-MM-DD date string (matches the @db.Date columns). */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** Indonesian-ish phone: digits, optional leading +, spaces/dashes allowed, 8-20 significant digits. */
const phoneSchema = z
  .string()
  .trim()
  .min(8, 'Phone number is too short')
  .max(20, 'Phone number is too long')
  .regex(/^\+?[0-9][0-9\s-]{6,18}[0-9]$/, 'Invalid phone number');

/**
 * Public booking submission body (PRD §6.13). Hardened:
 *   - NO tenantId/propertyId accepted (derived from the slug only — strict() rejects unknown keys
 *     so a forged `tenantId`/`propertyId`/`source` in the body is a 422, never silently honoured).
 *   - `_hp` is a HONEYPOT field — must be empty; if a bot fills it, the controller fakes success.
 *   - `roomId` optional → a room-less inquiry lead is allowed.
 *   - check-in date must be a valid YYYY-MM-DD and not in the past (today allowed).
 */
export const publicBookingSchema = z
  .object({
    prospectName: z.string().trim().min(2, 'Name is too short').max(150),
    prospectPhone: phoneSchema,
    prospectEmail: z.string().trim().email().max(150).optional(),
    roomId: z.string().uuid().optional(),
    plannedCheckInDate: dateString,
    message: z.string().trim().max(1000).optional(),
    // Honeypot — legitimate clients leave this empty/absent. Bots tend to autofill every field.
    _hp: z.string().max(0, 'spam detected').optional().or(z.literal('')),
  })
  .strict()
  .refine(
    (v) => {
      const today = new Date();
      const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(
        today.getUTCDate(),
      ).padStart(2, '0')}`;
      return v.plannedCheckInDate >= todayStr;
    },
    { message: 'Check-in date cannot be in the past', path: ['plannedCheckInDate'] },
  );

export type SlugParam = z.infer<typeof slugParamSchema>;
export type PublicBookingInput = z.infer<typeof publicBookingSchema>;
