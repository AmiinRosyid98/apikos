import { Router } from 'express';
import * as ctrl from './push.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL } from '../../middleware/rbacGuard';
import { subscribeSchema, unsubscribeSchema } from './push.validators';

/**
 * Web Push module routes (PRD §6.18). Everything is PER-USER — every endpoint operates on
 * `req.auth.userId` (the current user) within their tenant. ALL roles are allowed (registering a
 * personal device, like the notifications router). No plan gate.
 *
 * Push is OPTIONAL: when VAPID env is absent the service is a no-op and `/public-key` returns null
 * — these routes still respond 200, push is simply unavailable.
 */
export const pushRouter = Router();

pushRouter.post(
  '/subscribe',
  rbacGuard(ALL),
  validate(subscribeSchema),
  asyncHandler(ctrl.subscribe),
);
pushRouter.post(
  '/unsubscribe',
  rbacGuard(ALL),
  validate(unsubscribeSchema),
  asyncHandler(ctrl.unsubscribe),
);
pushRouter.get('/public-key', rbacGuard(ALL), asyncHandler(ctrl.publicKey));
pushRouter.post('/test', rbacGuard(ALL), asyncHandler(ctrl.test));
