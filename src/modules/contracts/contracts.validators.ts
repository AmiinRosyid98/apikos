import { z } from 'zod';

export const contractStatusEnum = z.enum(['draft', 'active', 'signed', 'expired', 'terminated']);
export const documentTypeEnum = z.enum(['ktp', 'sim', 'kk', 'contract', 'other']);

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date');

// ─────────────────────────── Contract templates ───────────────────────────

/**
 * Create a contract template (PRD §6.15). `propertyId` null/omitted = tenant default (applies to
 * all properties unless overridden by a property-specific template). `body` holds {variabel}
 * placeholders (see TEMPLATE_VARIABLES) rendered at generation time.
 */
export const createTemplateSchema = z.object({
  propertyId: z.string().uuid().nullable().optional(),
  name: z.string().min(2).max(200),
  body: z.string().min(1).max(50000),
  isActive: z.boolean().default(true),
});

export const updateTemplateSchema = z.object({
  propertyId: z.string().uuid().nullable().optional(),
  name: z.string().min(2).max(200).optional(),
  body: z.string().min(1).max(50000).optional(),
  isActive: z.boolean().optional(),
});

export const listTemplateQuery = z.object({
  property_id: z.string().uuid().optional(),
  is_active: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

// ─────────────────────────── Contracts ───────────────────────────

/**
 * Generate a contract for a resident (PRD §6.15). Renders the chosen template (or the resident's
 * property default/active template if `templateId` omitted) into a stable `body` snapshot, allocates
 * a sequential `contractNumber`, and stores it as `draft`. `endDate` must be after `startDate`.
 */
export const createContractSchema = z
  .object({
    residentId: z.string().uuid(),
    templateId: z.string().uuid().nullable().optional(),
    startDate: dateString,
    endDate: dateString,
    notes: z.string().max(5000).optional(),
  })
  .refine((d) => Date.parse(d.endDate) > Date.parse(d.startDate), {
    message: 'endDate must be after startDate',
    path: ['endDate'],
  });

/**
 * Convenience generate from POST /residents/:id/contract — same as createContract but residentId
 * comes from the path. `templateId` optional (defaults to the property default/active template).
 * Dates optional: default startDate = resident.checkInDate, endDate = resident.contractEndDate (or
 * startDate + 1 year if none).
 */
export const createContractForResidentSchema = z
  .object({
    templateId: z.string().uuid().nullable().optional(),
    startDate: dateString.optional(),
    endDate: dateString.optional(),
    notes: z.string().max(5000).optional(),
  })
  .refine(
    (d) => !d.startDate || !d.endDate || Date.parse(d.endDate) > Date.parse(d.startDate),
    { message: 'endDate must be after startDate', path: ['endDate'] },
  );

export const listContractQuery = z.object({
  resident_id: z.string().uuid().optional(),
  property_id: z.string().uuid().optional(),
  status: contractStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

/** Sign a contract (Manager+). Resident signature key required; owner signature key optional. */
export const signContractSchema = z.object({
  residentSignatureKey: z.string().min(1).max(500),
  ownerSignatureKey: z.string().min(1).max(500).optional(),
});

/**
 * Change contract status (Manager+) — activate / terminate / expire. Valid transitions enforced in
 * the service (invalid → 409). `notes` optional (e.g. termination reason).
 */
export const contractStatusSchema = z.object({
  status: contractStatusEnum,
  notes: z.string().max(5000).optional(),
});

// ─────────────────────────── Documents ───────────────────────────

export const createDocumentSchema = z.object({
  type: documentTypeEnum.default('other'),
  name: z.string().min(1).max(200),
  fileKey: z.string().min(1).max(500),
  propertyId: z.string().uuid().nullable().optional(),
  expiresAt: dateString.nullable().optional(),
  notes: z.string().max(5000).optional(),
});

export const listDocumentByResidentQuery = z.object({
  type: documentTypeEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export const expiringDocumentQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  property_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type ListTemplateQuery = z.infer<typeof listTemplateQuery>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type CreateContractForResidentInput = z.infer<typeof createContractForResidentSchema>;
export type ListContractQuery = z.infer<typeof listContractQuery>;
export type SignContractInput = z.infer<typeof signContractSchema>;
export type ContractStatusInput = z.infer<typeof contractStatusSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type ListDocumentByResidentQuery = z.infer<typeof listDocumentByResidentQuery>;
export type ExpiringDocumentQuery = z.infer<typeof expiringDocumentQuery>;
