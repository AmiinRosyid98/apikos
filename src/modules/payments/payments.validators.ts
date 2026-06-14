import { z } from 'zod';

export const paymentMethodEnum = z.enum([
  'qris',
  'va_bca',
  'va_bni',
  'va_bri',
  'va_mandiri',
  'va_permata',
  'gopay',
  'ovo',
  'dana',
  'shopeepay',
  'linkaja',
]);

export const txnStatusEnum = z.enum(['pending', 'paid', 'expired', 'failed']);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

// ── Create charge: POST /invoices/:id/charge ──
export const createChargeSchema = z.object({
  method: paymentMethodEnum,
});

// ── Webhook: POST /webhooks/payment (public). Body is provider-shaped; we accept anything an object
// and let the provider.verifyWebhook parse it. A minimal guard keeps it an object. ──
export const webhookSchema = z.record(z.unknown());

// ── Simulate: POST /payment-txns/:id/simulate (stub-only). Optionally choose the outcome. ──
export const simulateSchema = z
  .object({
    outcome: z.enum(['paid', 'failed', 'expired']).default('paid'),
  })
  .default({ outcome: 'paid' });

// ── List txns: GET /payment-txns ──
export const listTxnQuery = z.object({
  status: txnStatusEnum.optional(),
  method: paymentMethodEnum.optional(),
  date_from: dateString.optional(),
  date_to: dateString.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

// ── Reconciliation: GET /payments/reconciliation ──
export const reconciliationQuery = z.object({
  property_id: z.string().uuid().optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export type CreateChargeInput = z.infer<typeof createChargeSchema>;
export type SimulateInput = z.infer<typeof simulateSchema>;
export type ListTxnQuery = z.infer<typeof listTxnQuery>;
export type ReconciliationQuery = z.infer<typeof reconciliationQuery>;
