import { Router } from 'express';
import * as ctrl from './notifications.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL } from '../../middleware/rbacGuard';
import { listNotificationsQuery, updatePreferencesSchema } from './notifications.validators';

/**
 * In-App Notification module routes (PRD §6.18). Everything is PER-USER — every endpoint operates
 * on `req.auth.userId` (the current user) within their tenant. ALL roles are allowed (a notification
 * center is personal). No plan gate.
 *
 * Browser push (VAPID/web-push) is DEFERRED — see the seam in src/services/notification.service.ts.
 */

// ── /api/v1/notifications ──
export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listNotificationsQuery, 'query'),
  asyncHandler(ctrl.list),
);
// Static paths BEFORE the :id route. "unread-count" / "read-all" are not UUIDs (the UUID-param guard
// never matches them) and the literal paths take precedence over the param route anyway.
notificationsRouter.get('/unread-count', rbacGuard(ALL), asyncHandler(ctrl.unreadCount));
notificationsRouter.post('/read-all', rbacGuard(ALL), asyncHandler(ctrl.readAll));
notificationsRouter.patch('/:id/read', rbacGuard(ALL), asyncHandler(ctrl.markRead));

// ── /api/v1/notification-preferences ──
export const notificationPreferencesRouter = Router();
notificationPreferencesRouter.get('/', rbacGuard(ALL), asyncHandler(ctrl.getPreferences));
notificationPreferencesRouter.put(
  '/',
  rbacGuard(ALL),
  validate(updatePreferencesSchema),
  asyncHandler(ctrl.updatePreferences),
);
