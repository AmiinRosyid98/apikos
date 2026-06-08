import { z } from 'zod';

export const roomStatusEnum = z.enum([
  'empty',
  'occupied',
  'booking',
  'maintenance',
  'renovation',
]);

export const createRoomSchema = z.object({
  roomNumber: z.string().min(1).max(30),
  roomType: z.string().min(1).max(50),
  floor: z.number().int().min(0).max(200).optional(),
  areaM2: z.number().min(0).optional(),
  basePrice: z.number().min(0),
  facilities: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
});

export const updateRoomSchema = createRoomSchema.partial().extend({
  roomNumber: z.string().min(1).max(30),
  roomType: z.string().min(1).max(50),
  basePrice: z.number().min(0),
});

export const roomStatusSchema = z.object({ status: roomStatusEnum });

export const cloneRoomSchema = z.object({
  count: z.number().int().min(1).max(50).default(1),
  roomNumberPrefix: z.string().max(20).optional(),
});

export const bulkPriceSchema = z.object({
  filter: z.object({ roomType: z.string().optional() }).default({}),
  adjustType: z.enum(['percent', 'flat']),
  value: z.number(),
});

export const roomPhotosSchema = z.object({
  keys: z.array(z.string().min(1)).min(1),
});

export const listRoomQuery = z.object({
  status: roomStatusEnum.optional(),
  room_type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;
export type ListRoomQuery = z.infer<typeof listRoomQuery>;
export type CloneRoomInput = z.infer<typeof cloneRoomSchema>;
export type BulkPriceInput = z.infer<typeof bulkPriceSchema>;
