import { Router } from 'express';
import * as ctrl from './properties.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL, OWNER_ONLY, OWNER_MANAGER, loadPropertyScope } from '../../middleware/rbacGuard';
import {
  createPropertySchema,
  updatePropertySchema,
  listPropertyQuery,
} from './properties.validators';

// Mounted at /api/v1/properties (already behind authGuard + tenantContext in the API router).
const router = Router();

router.get('/', loadPropertyScope, rbacGuard(ALL), validate(listPropertyQuery, 'query'), asyncHandler(ctrl.list));
router.post('/', rbacGuard(OWNER_ONLY), validate(createPropertySchema), asyncHandler(ctrl.create));
router.get('/:id', loadPropertyScope, rbacGuard(ALL), asyncHandler(ctrl.detail));
router.put('/:id', loadPropertyScope, rbacGuard(OWNER_MANAGER), validate(updatePropertySchema), asyncHandler(ctrl.update));
router.delete('/:id', rbacGuard(OWNER_ONLY), asyncHandler(ctrl.deactivate));

export default router;
