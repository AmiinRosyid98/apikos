import { z } from 'zod';

export const notificationTypeEnum = z.enum([
  'payment_received',
  'booking_new',
  'maintenance_critical',
  'contract_expiring',
  'invoice_overdue',
  'general',
]);

/** GET /notifications — current user's notifications, filterable + paginated. */
export const listNotificationsQuery = z.object({
  unread: z.coerce.boolean().optional(), // unread=true → only unread
  type: notificationTypeEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * PUT /notification-preferences — per-type on/off map. All keys optional; an omitted key means
 * "leave as is / default enabled". `null`-able body keys are not allowed (use false to disable).
 */
export const updatePreferencesSchema = z
  .object({
    payment_received: z.boolean().optional(),
    booking_new: z.boolean().optional(),
    maintenance_critical: z.boolean().optional(),
    contract_expiring: z.boolean().optional(),
    invoice_overdue: z.boolean().optional(),
    general: z.boolean().optional(),
  })
  .strict();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
