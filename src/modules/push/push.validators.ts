import { z } from 'zod';

/**
 * POST /push/subscribe — register/upsert the current user's browser PushSubscription. Mirrors the
 * shape produced by the browser's `PushSubscription.toJSON()` (endpoint + keys{p256dh,auth}).
 */
export const subscribeSchema = z
  .object({
    endpoint: z.string().url().max(2000),
    keys: z
      .object({
        p256dh: z.string().min(1).max(512),
        auth: z.string().min(1).max(512),
      })
      .strict(),
    userAgent: z.string().max(512).optional(),
  })
  .strict();

/** POST /push/unsubscribe — remove the current user's subscription matching `endpoint`. */
export const unsubscribeSchema = z
  .object({
    endpoint: z.string().url().max(2000),
  })
  .strict();

export type SubscribeInput = z.infer<typeof subscribeSchema>;
export type UnsubscribeInput = z.infer<typeof unsubscribeSchema>;
