import { prisma } from '../../config/database';
import { env, webPushConfigured } from '../../config/env';
import { iso } from '../../utils/serialize';
import * as webpush from '../../services/webpush.service';
import type { SubscribeInput } from './push.validators';

/**
 * Push module service (PRD §6.18 web-push). All operations are PER-USER within the caller's tenant.
 * `req.auth` supplies `userId` + `tenantId`; the controller passes them in. Endpoint is globally
 * unique, so subscribe is an UPSERT keyed by endpoint that re-points the row to the current
 * user/tenant (a device that switched accounts is re-claimed, not duplicated).
 *
 * NOTE on the tenant-guard: the Prisma extension injects tenant_id on `create`/`createMany` and
 * filters WHERE on the find/update/deleteMany family, but it SKIPS `upsert`. We therefore pass
 * `tenantId`/`userId` explicitly in the upsert create+update bodies.
 */

/** Upsert the current user's subscription (unique by endpoint). Touches lastUsedAt on update. */
export async function upsertSubscription(
  userId: string,
  tenantId: string,
  input: SubscribeInput,
) {
  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      tenantId,
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent ?? null,
    },
    update: {
      // Re-point an existing endpoint to the current user/tenant and refresh its keys.
      tenantId,
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent ?? null,
      lastUsedAt: new Date(),
    },
    select: { id: true, endpoint: true, createdAt: true },
  });
  return { id: row.id, endpoint: row.endpoint, createdAt: iso(row.createdAt) };
}

/**
 * Remove the current user's subscription matching `endpoint`. Idempotent — removing a non-existent
 * / already-removed row still returns `{ removed: true }` (no 404 leak for a normal unsubscribe).
 * Scoped to the caller's own rows (userId) via the tenant-guarded deleteMany.
 */
export async function removeSubscription(userId: string, endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  return { removed: true };
}

/** The configured VAPID public key, or null when push is not configured. */
export function getPublicKey(): { publicKey: string | null } {
  return { publicKey: webPushConfigured ? env.VAPID_PUBLIC_KEY : null };
}

/**
 * Send a test push to ALL of the current user's own subscriptions. Best-effort — transport failures
 * are swallowed inside the webpush service (never 5xx). Returns how many the user has + how many
 * succeeded (after stale-pruning).
 */
export async function sendTestToUser(userId: string) {
  const subscriptions = await prisma.pushSubscription.count({ where: { userId } });
  if (subscriptions === 0) return { sent: 0, subscriptions: 0 };

  const sent = await webpush.sendToUser(userId, {
    title: 'Notifikasi uji KosManager',
    body: 'Notifikasi push di perangkat ini aktif. 🎉',
    url: '/dashboard',
    type: 'general',
  });
  return { sent, subscriptions };
}
