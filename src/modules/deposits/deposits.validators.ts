import { z } from 'zod';

export const depositMethodEnum = z.enum(['cash', 'transfer', 'qris', 'other']);
export const depositStatusEnum = z.enum([
  'held',
  'partially_refunded',
  'refunded',
  'forfeited',
]);

/** YYYY-MM-DD date string. */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/**
 * Record a deposit receipt (PRD §6.6). status is set server-side to `held`.
 */
export const createDepositSchema = z.object({
  amount: z.number().positive('amount must be greater than 0'),
  method: depositMethodEnum.default('cash'),
  receivedDate: dateString,
  notes: z.string().max(1000).optional(),
});

/**
 * Refund (or forfeit) a deposit at check-out. The damage deduction is justified by the
 * check-out handover's documented inventory (Module B). Validated server-side:
 *   refundedAmount + deductionAmount <= amount  (422 otherwise).
 */
export const refundDepositSchema = z.object({
  refundedAmount: z.number().nonnegative('refundedAmount cannot be negative'),
  deductionAmount: z.number().nonnegative('deductionAmount cannot be negative').default(0),
  deductionNotes: z.string().max(2000).optional(),
  refundedDate: dateString,
});

export const listDepositsByResidentQuery = z.object({
  status: depositStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

/** Outstanding-deposits report. Defaults to status=held (the canonical "outstanding"). */
export const listDepositsReportQuery = z.object({
  status: depositStatusEnum.optional(),
  property_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateDepositInput = z.infer<typeof createDepositSchema>;
export type RefundDepositInput = z.infer<typeof refundDepositSchema>;
export type ListDepositsByResidentQuery = z.infer<typeof listDepositsByResidentQuery>;
export type ListDepositsReportQuery = z.infer<typeof listDepositsReportQuery>;
