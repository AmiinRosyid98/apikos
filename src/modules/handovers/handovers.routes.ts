import { Router } from 'express';
import * as ctrl from './handovers.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL, ADMIN_PLUS, loadPropertyScope } from '../../middleware/rbacGuard';
import { createHandoverSchema, listHandoversByResidentQuery } from './handovers.validators';

// ── Nested router for /api/v1/residents/:id/handovers (mergeParams to read :id) ──
export const residentHandoversRouter = Router({ mergeParams: true });
residentHandoversRouter.use(loadPropertyScope);

residentHandoversRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listHandoversByResidentQuery, 'query'),
  asyncHandler(ctrl.listByResident),
);
// Base gate is ADMIN_PLUS (allows check-in). Check-out requires Manager+ — enforced per-type
// in the controller after the body is validated.
residentHandoversRouter.post(
  '/',
  rbacGuard(ADMIN_PLUS),
  validate(createHandoverSchema),
  asyncHandler(ctrl.createForResident),
);

// ── Direct router for /api/v1/handovers/:id (+ /pdf) ──
export const handoversRouter = Router();
handoversRouter.use(loadPropertyScope);
handoversRouter.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.detail));
handoversRouter.get('/:id/pdf', rbacGuard(ALL), asyncHandler(ctrl.pdf));
