import { Router } from 'express';
import * as ctrl from './bookings.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  rbacGuard,
  ALL,
  ADMIN_PLUS,
  MANAGER_PLUS,
  loadPropertyScope,
} from '../../middleware/rbacGuard';
import {
  createBookingSchema,
  convertBookingSchema,
  cancelBookingSchema,
  listBookingQuery,
} from './bookings.validators';

/**
 * Booking Management routes (PRD §6.13). RBAC (PRD §11/§13):
 *   create  → Admin+ (owner/manager/admin)
 *   confirm → Manager+ (owner/manager)
 *   convert → Admin+
 *   cancel  → Manager+
 *   view    → All (list/detail)
 *
 * NOTE: these are the INTERNAL (authenticated) booking routes. The public self-service booking
 * endpoint is deferred — see the PUBLIC BOOKING SEAM comment in bookings.service.ts.
 */
const router = Router();
router.use(loadPropertyScope);

router.get('/', rbacGuard(ALL), validate(listBookingQuery, 'query'), asyncHandler(ctrl.list));
router.post('/', rbacGuard(ADMIN_PLUS), validate(createBookingSchema), asyncHandler(ctrl.create));
router.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.detail));
router.patch('/:id/confirm', rbacGuard(MANAGER_PLUS), asyncHandler(ctrl.confirm));
router.patch(
  '/:id/convert',
  rbacGuard(ADMIN_PLUS),
  validate(convertBookingSchema),
  asyncHandler(ctrl.convert),
);
router.patch(
  '/:id/cancel',
  rbacGuard(MANAGER_PLUS),
  validate(cancelBookingSchema),
  asyncHandler(ctrl.cancel),
);

export default router;
