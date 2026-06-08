import { z } from 'zod';

export const genderEnum = z.enum(['male', 'female']);
export const residentStatusEnum = z.enum(['active', 'alumni', 'blacklisted']);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const createResidentSchema = z.object({
  propertyId: z.string().uuid(),
  roomId: z.string().uuid(),
  fullName: z.string().min(2).max(150),
  nik: z.string().regex(/^\d{16}$/, 'NIK must be 16 digits').optional(),
  phone: z.string().min(5).max(30),
  email: z.string().email().optional(),
  occupation: z.string().max(120).optional(),
  gender: genderEnum.optional(),
  ktpKey: z.string().optional(),
  selfieKey: z.string().optional(),
  emergencyContact: z
    .object({
      name: z.string().max(120).optional(),
      phone: z.string().max(30).optional(),
      relation: z.string().max(60).optional(),
    })
    .default({}),
  checkInDate: dateString,
  contractEndDate: dateString.optional(),
  monthlyRent: z.number().min(0),
  internalNotes: z.string().max(2000).optional(),
});

export const updateResidentSchema = z.object({
  fullName: z.string().min(2).max(150),
  nik: z.string().regex(/^\d{16}$/, 'NIK must be 16 digits').optional(),
  phone: z.string().min(5).max(30),
  email: z.string().email().optional(),
  occupation: z.string().max(120).optional(),
  gender: genderEnum.optional(),
  ktpKey: z.string().optional(),
  selfieKey: z.string().optional(),
  emergencyContact: z
    .object({
      name: z.string().max(120).optional(),
      phone: z.string().max(30).optional(),
      relation: z.string().max(60).optional(),
    })
    .optional(),
  contractEndDate: dateString.optional(),
  monthlyRent: z.number().min(0),
  internalNotes: z.string().max(2000).optional(),
});

export const moveResidentSchema = z.object({
  newRoomId: z.string().uuid(),
  effectiveDate: dateString,
});

export const checkoutResidentSchema = z.object({
  checkOutDate: dateString,
  notes: z.string().max(1000).optional(),
});

export const residentStatusSchema = z.object({ status: residentStatusEnum });

export const listResidentQuery = z.object({
  status: residentStatusEnum.optional(),
  property_id: z.string().uuid().optional(),
  room_id: z.string().uuid().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateResidentInput = z.infer<typeof createResidentSchema>;
export type UpdateResidentInput = z.infer<typeof updateResidentSchema>;
export type ListResidentQuery = z.infer<typeof listResidentQuery>;
export type MoveResidentInput = z.infer<typeof moveResidentSchema>;
export type CheckoutResidentInput = z.infer<typeof checkoutResidentSchema>;
