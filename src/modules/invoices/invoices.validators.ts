import { z } from 'zod';

export const invoiceItemTypeEnum = z.enum([
  'rent',
  'electricity',
  'water',
  'internet',
  'other',
]);
export const paymentMethodEnum = z.enum([
  'cash',
  'transfer',
  'qris',
  'va',
  'ewallet',
  'other',
]);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const dateTimeString = z.string().datetime().or(dateString);

const invoiceItemInput = z.object({
  type: invoiceItemTypeEnum.default('other'),
  description: z.string().min(1).max(200),
  quantity: z.number().min(0).default(1),
  unitPrice: z.number().min(0),
  amount: z.number().min(0),
});

export const generateInvoiceSchema = z.object({
  propertyId: z.string().uuid(),
  periodMonth: z.number().int().min(1).max(12),
  periodYear: z.number().int().min(2000).max(2100),
  residentIds: z.array(z.string().uuid()).optional(),
});

export const createInvoiceSchema = z.object({
  residentId: z.string().uuid(),
  periodMonth: z.number().int().min(1).max(12),
  periodYear: z.number().int().min(2000).max(2100),
  dueDate: dateString,
  items: z.array(invoiceItemInput).min(1),
});

export const updateInvoiceSchema = z.object({
  items: z.array(invoiceItemInput).min(1),
  notes: z.string().max(1000).optional(),
});

export const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  method: paymentMethodEnum,
  paidAt: dateTimeString,
  reference: z.string().max(120).optional(),
  proofKey: z.string().optional(),
});

export const markPaidSchema = z.object({
  method: paymentMethodEnum.optional(),
  paidAt: dateTimeString.optional(),
});

export const cancelInvoiceSchema = z.object({
  reason: z.string().min(2).max(500),
});

/**
 * Admin/owner on-demand trigger for the scheduled invoice-generation run. Enqueues a BullMQ
 * job scoped to the caller's tenant. `asOf` (optional) lets an operator simulate a specific
 * billing day; defaults to "now" in the worker.
 */
export const generateRunSchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .optional(),
});

export const listInvoiceQuery = z.object({
  status: z.enum(['unpaid', 'partial', 'paid', 'overdue', 'cancelled']).optional(),
  property_id: z.string().uuid().optional(),
  resident_id: z.string().uuid().optional(),
  period_month: z.coerce.number().int().min(1).max(12).optional(),
  period_year: z.coerce.number().int().min(2000).max(2100).optional(),
  overdue: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type GenerateRunInput = z.infer<typeof generateRunSchema>;
export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type ListInvoiceQuery = z.infer<typeof listInvoiceQuery>;
