import { z } from 'zod';

/** Providers a tenant may configure. 'stub' needs no key; 'jurnal'/'accurate' use the encrypted key. */
export const accountingProviderEnum = z.enum(['stub', 'jurnal', 'accurate']);

export const accountingEntityTypeEnum = z.enum(['payment', 'expense']);
export const accountingEntryTypeEnum = z.enum(['income', 'expense']);
export const accountingSyncStatusEnum = z.enum(['pending', 'synced', 'failed']);

// ── PUT /accounting/config (Owner-only, Premium-gated). Partial: only present keys are touched. ──
export const updateConfigSchema = z
  .object({
    provider: accountingProviderEnum.optional(),
    enabled: z.boolean().optional(),
    // The provider API key (plaintext in; stored encrypted). `null` clears it. Stub needs none.
    apiKey: z.string().min(1).max(2000).nullable().optional(),
    // When true, run a provider testConnection and include the result in the response.
    testConnection: z.boolean().optional(),
  })
  .strict();

// ── POST /accounting/sync (owner/manager/finance). Optional period / property scope. ──
export const syncSchema = z
  .object({
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    property_id: z.string().uuid().optional(),
  })
  .strict()
  .optional()
  .default({});

// ── GET /accounting/entries (owner/manager/finance). ──
export const listEntriesQuery = z.object({
  status: accountingSyncStatusEnum.optional(),
  type: accountingEntryTypeEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;
export type SyncInput = z.infer<typeof syncSchema>;
export type ListEntriesQuery = z.infer<typeof listEntriesQuery>;
