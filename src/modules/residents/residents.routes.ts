import { Router } from 'express';
import * as ctrl from './residents.controller';
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
  createResidentSchema,
  updateResidentSchema,
  moveResidentSchema,
  checkoutResidentSchema,
  residentStatusSchema,
  listResidentQuery,
} from './residents.validators';

const router = Router();
router.use(loadPropertyScope);

router.get('/', rbacGuard(ALL), validate(listResidentQuery, 'query'), asyncHandler(ctrl.list));
router.post('/', rbacGuard(ADMIN_PLUS), validate(createResidentSchema), asyncHandler(ctrl.create));
router.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.detail));
router.put('/:id', rbacGuard(ADMIN_PLUS), validate(updateResidentSchema), asyncHandler(ctrl.update));
router.post('/:id/move', rbacGuard(MANAGER_PLUS), validate(moveResidentSchema), asyncHandler(ctrl.move));
router.post('/:id/checkout', rbacGuard(MANAGER_PLUS), validate(checkoutResidentSchema), asyncHandler(ctrl.checkout));
router.patch('/:id/status', rbacGuard(MANAGER_PLUS), validate(residentStatusSchema), asyncHandler(ctrl.setStatus));

export default router;
