import type { NotificationType } from '@prisma/client';
import { prisma } from '../config/database';
import type { JwtRole } from '../utils/jwt';
import * as webpush from './webpush.service';

/**
 * In-App Notification service (PRD §6.18).
 *
 * `notify()` is the single emit point called from existing business events (payment success,
 * booking create, critical maintenance, contract/document expiring). It resolves the recipients
 * (active tenant users matching the type's default roles, or explicit userIds), filters by each
 * user's per-type preferences, and creates one `notifications` row per recipient.
 *
 * CONTRACT GUARANTEES:
 *   - BEST-EFFORT / FAILURE-ISOLATED: `notify()` NEVER throws. Any error is caught + logged so a
 *     notification failure can never break the triggering business action (the caller still wraps
 *     it in `.catch(() => {})` as belt-and-braces, but the function itself is already safe).
 *   - TENANT-SCOPED: writes go through the tenant-guarded Prisma client. The caller MUST already be
 *     inside a tenant context (request middleware sets it; jobs/webhooks wrap in `runWithTenant`).
 *     `tenantId` is passed explicitly (required by Prisma's generated types; the guard also injects).
 *   - PREFERENCE-AWARE: a user with `notificationPrefs[type] === false` is skipped. NULL prefs (or a
 *     missing key) = enabled (opt-out model).
 *
 * BROWSER-PUSH SEAM (IMPLEMENTED — PRD §6.18 web-push):
 *   This is the SINGLE hook point. After the in-app rows are created, we fan out a fire-and-forget
 *   web push to each already role/pref-filtered recipient that has a stored `push_subscriptions`
 *   row, via `webpush.sendToUser(userId, payload)`. No caller changes are needed — every business
 *   event already routes through `notify()`. The fan-out is non-blocking (`void` + `.catch()`) and
 *   failure-isolated: `webpush.sendToUser` never throws, swallows transport errors, and prunes
 *   stale (404/410) subscriptions. When VAPID env is absent the webpush service is a no-op.
 */

export const NOTIFICATION_TYPES: NotificationType[] = [
  'payment_received',
  'booking_new',
  'maintenance_critical',
  'contract_expiring',
  'invoice_overdue',
  'general',
];

/**
 * Default recipient role mapping (PRD §6.18 — sensible, documented defaults). Used when a caller
 * does not pass an explicit `roles` or `userIds`. "Who cares about this event":
 *   - payment_received    → owner / manager / finance (the money roles)
 *   - booking_new         → owner / manager / admin   (ops roles handling intake)
 *   - maintenance_critical→ owner / manager / admin   (ops roles handling repairs)
 *   - contract_expiring   → owner / manager           (managerial — renewals)
 *   - invoice_overdue     → owner / manager           (managerial — collections)
 *   - general             → owner / manager / admin / finance (everyone)
 */
export const DEFAULT_ROLES_BY_TYPE: Record<NotificationType, JwtRole[]> = {
  payment_received: ['owner', 'manager', 'finance'],
  booking_new: ['owner', 'manager', 'admin'],
  maintenance_critical: ['owner', 'manager', 'admin'],
  contract_expiring: ['owner', 'manager'],
  invoice_overdue: ['owner', 'manager'],
  general: ['owner', 'manager', 'admin', 'finance'],
};

export interface NotifyInput {
  tenantId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Override the default role mapping. */
  roles?: JwtRole[];
  /** Explicit recipients (bypasses role resolution; still preference-filtered). */
  userIds?: string[];
  /**
   * Idempotency guard: when true, skip creating a row for a recipient who ALREADY has an unread (or,
   * if `dedupeIncludeRead`, any) notification with the same (type, entityType, entityId). Used by the
   * daily expiring sweep so the same entity is not re-notified every day.
   */
  dedupe?: boolean;
  dedupeIncludeRead?: boolean;
}

/** Whether a user's prefs allow this notification type (NULL prefs / missing key = enabled). */
export function prefAllows(prefs: unknown, type: NotificationType): boolean {
  if (prefs === null || prefs === undefined) return true;
  if (typeof prefs !== 'object') return true;
  const value = (prefs as Record<string, unknown>)[type];
  if (value === undefined || value === null) return true;
  return value !== false;
}

/**
 * Emit an in-app notification to the resolved recipients. Returns the number of rows created.
 * NEVER throws — failures are logged and swallowed.
 */
export async function notify(input: NotifyInput): Promise<number> {
  try {
    const roles = input.roles ?? DEFAULT_ROLES_BY_TYPE[input.type];

    // Resolve candidate recipients: explicit userIds OR active tenant users in the target roles.
    // (The tenant-guard scopes these queries to the current tenant; tenantId is also explicit.)
    const candidates = input.userIds
      ? await prisma.user.findMany({
          where: { id: { in: input.userIds }, isActive: true },
          select: { id: true, notificationPrefs: true },
        })
      : await prisma.user.findMany({
          where: { isActive: true, role: { in: roles } },
          select: { id: true, notificationPrefs: true },
        });

    // Preference filter (per-type opt-out; NULL = all enabled).
    let recipients = candidates.filter((u) => prefAllows(u.notificationPrefs, input.type));

    // Optional idempotency dedupe (used by the expiring sweep).
    if (input.dedupe && (input.entityType || input.entityId)) {
      const existing = await prisma.notification.findMany({
        where: {
          type: input.type,
          entityType: input.entityType ?? undefined,
          entityId: input.entityId ?? undefined,
          userId: { in: recipients.map((r) => r.id) },
          ...(input.dedupeIncludeRead ? {} : { isRead: false }),
        },
        select: { userId: true },
      });
      const skip = new Set(existing.map((e) => e.userId));
      recipients = recipients.filter((r) => !skip.has(r.id));
    }

    if (recipients.length === 0) return 0;

    await prisma.notification.createMany({
      data: recipients.map((r) => ({
        tenantId: input.tenantId,
        userId: r.id,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      })),
    });

    // ── BROWSER-PUSH FAN-OUT (web-push) ─────────────────────────────────────────────────────────
    // Fire-and-forget for each already role/pref-filtered recipient. MUST NOT block or throw:
    // notify() still returns immediately after the in-app rows are written. Transport errors and
    // stale-subscription pruning are handled inside webpush.sendToUser (never throws).
    const pushPayload = {
      title: input.title,
      body: input.body,
      url: input.link ?? null,
      type: input.type,
    };
    for (const r of recipients) {
      void webpush
        .sendToUser(r.id, pushPayload)
        .catch((e) =>
          // eslint-disable-next-line no-console
          console.error('[notification] web-push fan-out failed (swallowed):', (e as Error).message),
        );
    }
    // ────────────────────────────────────────────────────────────────────────────────────────────

    return recipients.length;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[notification] notify() failed (swallowed):', (e as Error).message);
    return 0;
  }
}
