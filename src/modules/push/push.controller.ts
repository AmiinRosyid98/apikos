import { Request, Response } from 'express';
import { ok } from '../../utils/response';
import * as svc from './push.service';
import type { SubscribeInput, UnsubscribeInput } from './push.validators';

/** POST /push/subscribe — upsert the caller's browser subscription (unique by endpoint). */
export async function subscribe(req: Request, res: Response) {
  const body = req.body as SubscribeInput;
  const data = await svc.upsertSubscription(req.auth!.userId, req.auth!.tenantId, body);
  return ok(res, data);
}

/** POST /push/unsubscribe — remove the caller's subscription by endpoint (idempotent). */
export async function unsubscribe(req: Request, res: Response) {
  const body = req.body as UnsubscribeInput;
  const data = await svc.removeSubscription(req.auth!.userId, body.endpoint);
  return ok(res, data);
}

/** GET /push/public-key — VAPID public key for client subscription (null if not configured). */
export async function publicKey(_req: Request, res: Response) {
  return ok(res, svc.getPublicKey());
}

/** POST /push/test — send a test push to the caller's own subscriptions (best-effort). */
export async function test(req: Request, res: Response) {
  const data = await svc.sendTestToUser(req.auth!.userId);
  return ok(res, data);
}
