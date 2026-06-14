import { z } from 'zod';
import { API_SCOPES } from './apikeys.scopes';

const scopeEnum = z.enum(API_SCOPES);

/**
 * Create an API key (PRD Modul 22). At least one scope is required; duplicates are de-duped.
 * `expiresAt` is an optional future ISO timestamp.
 */
export const createApiKeySchema = z.object({
  name: z.string().min(2).max(100),
  scopes: z
    .array(scopeEnum)
    .min(1, 'At least one scope is required')
    .transform((s) => Array.from(new Set(s))),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .or(z.string().datetime())
    .optional()
    .refine((v) => !v || new Date(v).getTime() > Date.now(), {
      message: 'expiresAt must be in the future',
    }),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
