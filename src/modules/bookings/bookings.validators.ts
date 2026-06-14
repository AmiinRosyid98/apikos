import { z } from 'zod';

export const bookingFeeMethodEnum = z.enum(['cash', 'transfer', 'qris', 'other']);
export const bookingStatusEnum = z.enum([
  'pending',
  'confirmed',
  'converted',
  'cancelled',
  'expired',
]);
export const genderEnum = z.enum(['male', 'female']);

/** YYYY-MM-DD date string (the @db.Date columns). */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** ISO timestamp (for feeDueAt — a deadline). */
const isoTimestamp = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime());

/**
 * Create an INTERNAL booking (PRD §6.13). The room must exist and be `empty`; only one active
 * (pending|confirmed) booking per room is allowed (enforced in the service + a partial unique
 * index). `feeDueAt` defaults to now + 24h in the service when omitted.
 */
export const createBookingSchema = z.object({
  roomId: z.string().uuid(),
  prospectName: z.string().min(2).max(150),
  prospectPhone: z.string().min(5).max(30),
  prospectEmail: z.string().email().optional(),
  plannedCheckInDate: dateString,
  bookingFeeAmount: z.number().min(0).default(0),
  bookingFeeMethod: bookingFeeMethodEnum.default('cash'),
  feeDueAt: isoTimestamp.optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * Convert a booking into a Resident + Occupancy (PRD §6.13). Completes the resident fields the
 * booking didn't capture. `monthlyRent` defaults to the room.basePrice; `checkInDate` defaults
 * to the booking.plannedCheckInDate (both resolved in the service). If `generateFirstInvoice`
 * is true, the first (pro-rata) invoice is generated via the shared invoice service.
 */
export const convertBookingSchema = z.object({
  monthlyRent: z.number().min(0).optional(),
  nik: z.string().regex(/^\d{16}$/, 'NIK must be 16 digits').optional(),
  gender: genderEnum.optional(),
  email: z.string().email().optional(),
  occupation: z.string().max(120).optional(),
  checkInDate: dateString.optional(),
  contractEndDate: dateString.optional(),
  emergencyContact: z
    .object({
      name: z.string().max(120).optional(),
      phone: z.string().max(30).optional(),
      relation: z.string().max(60).optional(),
    })
    .optional(),
  ktpKey: z.string().optional(),
  selfieKey: z.string().optional(),
  internalNotes: z.string().max(2000).optional(),
  generateFirstInvoice: z.boolean().default(false),
});

export const cancelBookingSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const confirmBookingSchema = z.object({}).optional();

export const listBookingQuery = z.object({
  status: bookingStatusEnum.optional(),
  property_id: z.string().uuid().optional(),
  room_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type ConvertBookingInput = z.infer<typeof convertBookingSchema>;
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;
export type ListBookingQuery = z.infer<typeof listBookingQuery>;
