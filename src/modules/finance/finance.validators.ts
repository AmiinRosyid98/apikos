import { z } from 'zod';

/** YYYY-MM-DD date string. */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

const currentYear = new Date().getFullYear();

// ─────────────────────────── Expense categories ───────────────────────────
export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
});

export const listCategoriesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
});

// ─────────────────────────── Expenses ───────────────────────────
export const createExpenseSchema = z.object({
  // null/omitted propertyId = tenant-wide overhead.
  propertyId: z.string().uuid().nullish(),
  categoryId: z.string().uuid('categoryId must be a valid UUID'),
  amount: z.number().positive('amount must be greater than 0'),
  date: dateString,
  description: z.string().max(1000).optional(),
  vendorName: z.string().max(255).optional(),
  receiptKey: z.string().max(512).optional(),
});

export const updateExpenseSchema = z
  .object({
    propertyId: z.string().uuid().nullish(),
    categoryId: z.string().uuid().optional(),
    amount: z.number().positive('amount must be greater than 0').optional(),
    date: dateString.optional(),
    description: z.string().max(1000).nullish(),
    vendorName: z.string().max(255).nullish(),
    receiptKey: z.string().max(512).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const listExpensesQuery = z.object({
  property_id: z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
  date_from: dateString.optional(),
  date_to: dateString.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

// ─────────────────────────── Aggregations ───────────────────────────
export const cashflowQuery = z.object({
  property_id: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100).default(currentYear),
});

export const summaryQuery = z.object({
  property_id: z.string().uuid().optional(),
  month: z.coerce.number().int().min(1).max(12).default(new Date().getMonth() + 1),
  year: z.coerce.number().int().min(2000).max(2100).default(currentYear),
});

export const plQuery = z.object({
  property_id: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100).default(currentYear),
});

export const reconciliationQuery = z.object({
  property_id: z.string().uuid().optional(),
  month: z.coerce.number().int().min(1).max(12).default(new Date().getMonth() + 1),
  year: z.coerce.number().int().min(2000).max(2100).default(currentYear),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuery>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuery>;
export type CashflowQuery = z.infer<typeof cashflowQuery>;
export type SummaryQuery = z.infer<typeof summaryQuery>;
export type PlQuery = z.infer<typeof plQuery>;
export type ReconciliationQuery = z.infer<typeof reconciliationQuery>;
