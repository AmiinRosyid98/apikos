import { Router } from 'express';
import * as ctrl from './users.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { authGuard } from '../../middleware/authGuard';
import { tenantContext } from '../../middleware/tenantContext';
import { publicRateLimiter } from '../../middleware/rateLimiter';
import { rbacGuard, ALL, OWNER_ONLY } from '../../middleware/rbacGuard';
import {
  inviteUserSchema,
  acceptInviteSchema,
  changeRoleSchema,
  propertyAccessSchema,
  deactivateSchema,
  listUserQuery,
} from './users.validators';

const router = Router();

// Public accept-invite (token-based). Rate-limited.
router.post(
  '/accept-invite',
  publicRateLimiter,
  validate(acceptInviteSchema),
  asyncHandler(ctrl.acceptInvite),
);

// Authenticated + tenant-scoped routes.
router.use(authGuard, tenantContext);

router.get('/', rbacGuard(ALL), validate(listUserQuery, 'query'), asyncHandler(ctrl.list));
router.post('/invite', rbacGuard(OWNER_ONLY), validate(inviteUserSchema), asyncHandler(ctrl.invite));
router.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.detail));
router.patch('/:id/role', rbacGuard(OWNER_ONLY), validate(changeRoleSchema), asyncHandler(ctrl.changeRole));
router.patch('/:id/property-access', rbacGuard(OWNER_ONLY), validate(propertyAccessSchema), asyncHandler(ctrl.propertyAccess));
router.patch('/:id/deactivate', rbacGuard(OWNER_ONLY), validate(deactivateSchema), asyncHandler(ctrl.deactivate));

export default router;
