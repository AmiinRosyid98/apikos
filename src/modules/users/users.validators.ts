import { z } from 'zod';

export const roleEnum = z.enum(['owner', 'manager', 'admin', 'finance']);

export const inviteUserSchema = z.object({
  email: z.string().email().toLowerCase(),
  fullName: z.string().min(2).max(120),
  role: roleEnum,
  propertyIds: z.array(z.string().uuid()).default([]),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8),
});

export const changeRoleSchema = z.object({ role: roleEnum });

export const propertyAccessSchema = z.object({
  propertyIds: z.array(z.string().uuid()),
});

export const deactivateSchema = z.object({ is_active: z.boolean() });

export const listUserQuery = z.object({
  role: roleEnum.optional(),
  is_active: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type ListUserQuery = z.infer<typeof listUserQuery>;
