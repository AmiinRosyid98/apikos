import { z } from 'zod';

export const waTemplateTypeEnum = z.enum([
  'invoice_new',
  'reminder_due',
  'reminder_overdue',
  'payment_received',
  'contract_expiry',
  'broadcast',
  'custom',
]);

export const waMessageStatusEnum = z.enum(['queued', 'sent', 'failed', 'stub']);

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

// ── Templates ──
export const createTemplateSchema = z.object({
  propertyId: z.string().uuid().optional(),
  type: waTemplateTypeEnum.default('custom'),
  name: z.string().min(2).max(150),
  body: z.string().min(2).max(4000),
  isActive: z.boolean().default(true),
});

export const updateTemplateSchema = z
  .object({
    name: z.string().min(2).max(150).optional(),
    body: z.string().min(2).max(4000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export const listTemplateQuery = z.object({
  property_id: z.string().uuid().optional(),
  type: waTemplateTypeEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

// ── Send invoice via WA ──
// Which template to render for the invoice: invoice_new (default) or reminder_due.
export const sendInvoiceWaSchema = z
  .object({
    templateType: z.enum(['invoice_new', 'reminder_due']).default('invoice_new'),
  })
  .default({ templateType: 'invoice_new' });

// ── Broadcast ──
export const broadcastSchema = z.object({
  propertyId: z.string().uuid(),
  body: z.string().min(2).max(4000),
  audience: z.literal('active_residents').default('active_residents'),
});

// ── Logs ──
export const listLogsQuery = z.object({
  property_id: z.string().uuid().optional(),
  status: waMessageStatusEnum.optional(),
  date_from: dateString.optional(),
  date_to: dateString.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

// ── Reminder config ──
const offsetsSchema = z
  .object({
    h7: z.boolean(),
    h3: z.boolean(),
    h0: z.boolean(),
    h3plus: z.boolean(),
    h7plus: z.boolean(),
  })
  .partial();

const contractExpirySchema = z
  .object({
    h30: z.boolean(),
    h14: z.boolean(),
    h7: z.boolean(),
  })
  .partial();

export const reminderConfigSchema = z
  .object({
    enabled: z.boolean(),
    offsets: offsetsSchema,
    contractExpiry: contractExpirySchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type ListTemplateQuery = z.infer<typeof listTemplateQuery>;
export type SendInvoiceWaInput = z.infer<typeof sendInvoiceWaSchema>;
export type BroadcastInput = z.infer<typeof broadcastSchema>;
export type ListLogsQuery = z.infer<typeof listLogsQuery>;
export type ReminderConfigInput = z.infer<typeof reminderConfigSchema>;
