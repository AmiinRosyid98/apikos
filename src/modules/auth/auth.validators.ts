import { z } from 'zod';

const password = z.string().min(8, 'Password must be at least 8 characters');
const email = z.string().email().toLowerCase();

export const registerSchema = z.object({
  businessName: z.string().min(2).max(120),
  fullName: z.string().min(2).max(120),
  email,
  password,
  phone: z.string().min(5).max(30).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(10),
});

export const forgotPasswordSchema = z.object({
  email,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  newPassword: password,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
