import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import * as svc from './notifications.service';
import type { ListNotificationsQuery } from './notifications.validators';

/** GET /notifications — the current user's notifications (scoped by req.auth.userId + tenant). */
export async function list(req: Request, res: Response) {
  const q = vquery<ListNotificationsQuery>(req);
  const { rows, total } = await svc.listForUser(req.auth!.userId, q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

/** GET /notifications/unread-count → { count } (the badge). */
export async function unreadCount(req: Request, res: Response) {
  const count = await svc.unreadCount(req.auth!.userId);
  return ok(res, { count });
}

/** PATCH /notifications/:id/read — mark one own notification read (else 404). */
export async function markRead(req: Request, res: Response) {
  const updated = await svc.markRead(req.auth!.userId, req.params.id);
  return ok(res, updated);
}

/** POST /notifications/read-all — mark all the current user's notifications read. */
export async function readAll(req: Request, res: Response) {
  const count = await svc.markAllRead(req.auth!.userId);
  return ok(res, { updated: count });
}

/** GET /notification-preferences — current user's effective per-type prefs. */
export async function getPreferences(req: Request, res: Response) {
  const data = await svc.getPreferences(req.auth!.userId);
  return ok(res, data);
}

/** PUT /notification-preferences — merge per-type toggles for the current user. */
export async function updatePreferences(req: Request, res: Response) {
  const data = await svc.updatePreferences(req.auth!.userId, req.body);
  return ok(res, data);
}
