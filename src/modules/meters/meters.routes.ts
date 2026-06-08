import { Router } from 'express';
import * as ctrl from './meters.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL, ADMIN_PLUS, MANAGER_PLUS, loadPropertyScope } from '../../middleware/rbacGuard';
import {
  createMeterReadingSchema,
  updateMeterReadingSchema,
  listMeterReadingQuery,
} from './meters.validators';

// ── Nested router for /api/v1/rooms/:id/meter-readings (mergeParams to read :id) ──
export const roomMetersRouter = Router({ mergeParams: true });
roomMetersRouter.use(loadPropertyScope);
roomMetersRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listMeterReadingQuery, 'query'),
  asyncHandler(ctrl.listByRoom),
);
roomMetersRouter.post(
  '/',
  rbacGuard(ADMIN_PLUS),
  validate(createMeterReadingSchema),
  asyncHandler(ctrl.createForRoom),
);

// ── Direct router for /api/v1/meter-readings/:id ──
export const metersRouter = Router();
metersRouter.use(loadPropertyScope);
metersRouter.patch(
  '/:id',
  rbacGuard(ADMIN_PLUS),
  validate(updateMeterReadingSchema),
  asyncHandler(ctrl.update),
);
metersRouter.delete('/:id', rbacGuard(MANAGER_PLUS), asyncHandler(ctrl.remove));
