import webpush from 'web-push';
import { prisma } from '../config/database';
import { env, webPushConfigured } from '../config/env';

/**
 * Web Push transport (PRD §6.18 web-push seam). Thin wrapper around the `web-push` npm package
 * (VAPID signing + payload encryption). It is the SECOND transport behind the single emit point
 * `notify()` (src/services/notification.service.ts) — for every recipient that already received an
 * in-app row AND has a stored browser subscription, fire an OS/browser push.
 *
 * CONTRACT GUARANTEES (mirrors notify()):
 *   - OPTIONAL: when VAPID env is absent the service is a NO-OP (logs once at boot that push is
 *     disabled). `notify()` and the /push module still work; push is simply unavailable.
 *   - BEST-EFFORT / FAILURE-ISOLATED: nothing here EVER throws. Transport errors are logged +
 *     swallowed. A 404/410 from the push service (the browser unsubscribed / endpoint gone) prunes
 *     the stale row by endpoint.
 *   - TENANT-SCOPED: subscription lookups go through the tenant-guarded Prisma client; the caller
 *     (`notify()` / the /push controllers) is already inside a tenant context.
 */

let configured = false;

/** Push payload sent to the Service Worker (JSON-stringified for transport). */
export interface PushPayload {
  title: string;
  body: string;
  url?: string | null;
  type?: string | null;
}

/**
 * Configure VAPID details ONCE at boot. Safe to call multiple times (idempotent). When VAPID env is
 * missing, sets the disabled flag and logs once — never throws.
 */
export function configureWebPush(): void {
  if (configured) return;
  if (!webPushConfigured) {
    // eslint-disable-next-line no-console
    console.warn(
      '[webpush] VAPID keys not set (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) — web push DISABLED (no-op).',
    );
    return;
  }
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    configured = true;
    // eslint-disable-next-line no-console
    console.log('[webpush] web push ENABLED (VAPID configured).');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[webpush] configureWebPush() failed (push disabled):', (e as Error).message);
  }
}

/** Whether push sending is available (VAPID configured). */
export function isEnabled(): boolean {
  return webPushConfigured;
}

/** Shape of a stored subscription needed to send a push. */
export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Delete a stale subscription row by its (unique) endpoint. Never throws. */
async function pruneStale(endpoint: string): Promise<void> {
  try {
    // endpoint is globally unique → deleteMany by endpoint is safe + idempotent (and is a WHERE_OP,
    // so it stays tenant-scoped by the guard).
    await prisma.pushSubscription.deleteMany({ where: { endpoint } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[webpush] pruneStale failed (swallowed):', (e as Error).message);
  }
}

/**
 * Low-level: send ONE push to ONE subscription. Returns true on success, false on any failure.
 * NEVER throws. On HTTP 404/410 (gone) the stale subscription row is deleted by endpoint.
 */
export async function send(
  subscription: StoredSubscription,
  payload: PushPayload,
): Promise<boolean> {
  if (!webPushConfigured) return false;
  if (!configured) configureWebPush();
  if (!configured) return false;

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
    );
    return true;
  } catch (e) {
    const statusCode = (e as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      // Endpoint is gone — the browser unsubscribed or expired. Prune it.
      await pruneStale(subscription.endpoint);
    } else {
      // eslint-disable-next-line no-console
      console.error(
        `[webpush] send failed (status=${statusCode ?? 'n/a'}, swallowed):`,
        (e as Error).message,
      );
    }
    return false;
  }
}

/**
 * Send a push to ALL of a user's stored subscriptions (tenant-guarded). Prunes stale ones and
 * touches `lastUsedAt` on the ones that succeed. Returns the count successfully sent. NEVER throws.
 */
export async function sendToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!webPushConfigured) return 0;
  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { userId },
      select: { endpoint: true, p256dh: true, auth: true },
    });
    if (subs.length === 0) return 0;

    let sent = 0;
    const sentEndpoints: string[] = [];
    for (const sub of subs) {
      const ok = await send(sub, payload);
      if (ok) {
        sent += 1;
        sentEndpoints.push(sub.endpoint);
      }
    }

    if (sentEndpoints.length > 0) {
      // Touch lastUsedAt on the subscriptions that received the push (best-effort).
      await prisma.pushSubscription
        .updateMany({
          where: { endpoint: { in: sentEndpoints } },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => undefined);
    }

    return sent;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[webpush] sendToUser failed (swallowed):', (e as Error).message);
    return 0;
  }
}
