import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { iso } from '../../utils/serialize';
import {
  NOTIFICATION_TYPES,
  DEFAULT_ROLES_BY_TYPE,
  prefAllows,
} from '../../services/notification.service';
import type { ListNotificationsQuery, UpdatePreferencesInput } from './notifications.validators';

type NotificationRow = Prisma.NotificationGetPayload<object>;

export function serializeNotification(n: NotificationRow) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    entityType: n.entityType,
    entityId: n.entityId,
    isRead: n.isRead,
    readAt: iso(n.readAt),
    createdAt: iso(n.createdAt),
  };
}

/**
 * List the CURRENT user's notifications (scoped by userId + tenant), newest first, paginated.
 * The tenant-guard scopes by tenantId; the explicit `userId` filter scopes to the caller.
 */
export async function listForUser(userId: string, q: ListNotificationsQuery) {
  const where: Prisma.NotificationWhereInput = { userId };
  if (q.unread === true) where.isRead = false;
  if (q.type) where.type = q.type;

  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.notification.count({ where }),
  ]);
  return { rows: rows.map(serializeNotification), total };
}

/** Current user's unread count (the badge). */
export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

/**
 * Mark ONE of the current user's notifications read. Only the owner can mark their own — a row
 * belonging to another user (or another tenant) resolves to 404 (no existence leak, per §2.2).
 */
export async function markRead(userId: string, id: string) {
  // findFirst is tenant-guarded; the userId filter enforces per-user ownership.
  const existing = await prisma.notification.findFirst({ where: { id, userId } });
  if (!existing) throw Errors.notFound('Notification not found');
  if (existing.isRead) return serializeNotification(existing);
  const updated = await prisma.notification.update({
    where: { id },
    data: { isRead: true, readAt: new Date() },
  });
  return serializeNotification(updated);
}

/** Mark ALL of the current user's unread notifications read. Returns the count flipped. */
export async function markAllRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count;
}

// ─────────────────────────── Preferences ───────────────────────────
/**
 * Build the effective per-type preference map for a user (NULL stored prefs → all enabled). Always
 * returns every known type as a boolean so the frontend can render toggles directly.
 */
export function effectivePrefs(stored: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const type of NOTIFICATION_TYPES) {
    out[type] = prefAllows(stored, type);
  }
  return out;
}

/** GET /notification-preferences — current user's effective per-type prefs (+ the role mapping). */
export async function getPreferences(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  if (!user) throw Errors.notFound('User not found');
  return {
    preferences: effectivePrefs(user.notificationPrefs),
    // Document the default recipient role mapping so the UI can explain "who gets what".
    defaultRolesByType: DEFAULT_ROLES_BY_TYPE,
  };
}

/**
 * PUT /notification-preferences — merge the supplied per-type toggles into the user's stored prefs
 * (partial update; omitted keys are left unchanged). Returns the effective prefs.
 */
export async function updatePreferences(userId: string, input: UpdatePreferencesInput) {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  if (!user) throw Errors.notFound('User not found');

  const current =
    user.notificationPrefs && typeof user.notificationPrefs === 'object'
      ? (user.notificationPrefs as Record<string, boolean>)
      : {};
  const merged: Record<string, boolean> = { ...current };
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) merged[k] = v;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { notificationPrefs: merged as Prisma.InputJsonValue },
  });
  return { preferences: effectivePrefs(merged), defaultRolesByType: DEFAULT_ROLES_BY_TYPE };
}
