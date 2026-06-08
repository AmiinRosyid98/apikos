import { Router } from 'express';
import * as ctrl from './rooms.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  rbacGuard,
  ALL,
  ADMIN_PLUS,
  OWNER_MANAGER,
  loadPropertyScope,
} from '../../middleware/rbacGuard';
import {
  createRoomSchema,
  updateRoomSchema,
  roomStatusSchema,
  cloneRoomSchema,
  bulkPriceSchema,
  roomPhotosSchema,
  listRoomQuery,
} from './rooms.validators';

// ── /api/v1/rooms ──
export const roomsRouter = Router();
roomsRouter.use(loadPropertyScope);
roomsRouter.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.detail));
roomsRouter.put('/:id', rbacGuard(ADMIN_PLUS), validate(updateRoomSchema), asyncHandler(ctrl.update));
roomsRouter.patch('/:id/status', rbacGuard(ADMIN_PLUS), validate(roomStatusSchema), asyncHandler(ctrl.setStatus));
roomsRouter.post('/:id/clone', rbacGuard(ADMIN_PLUS), validate(cloneRoomSchema), asyncHandler(ctrl.clone));
roomsRouter.post('/:id/photos', rbacGuard(ADMIN_PLUS), validate(roomPhotosSchema), asyncHandler(ctrl.addPhotos));

// ── Nested router for /api/v1/properties/:id/rooms (mergeParams to read :id) ──
export const propertyRoomsRouter = Router({ mergeParams: true });
propertyRoomsRouter.use(loadPropertyScope);
propertyRoomsRouter.get('/', rbacGuard(ALL), validate(listRoomQuery, 'query'), asyncHandler(ctrl.listByProperty));
propertyRoomsRouter.post('/', rbacGuard(ADMIN_PLUS), validate(createRoomSchema), asyncHandler(ctrl.createInProperty));
propertyRoomsRouter.post('/bulk-price', rbacGuard(OWNER_MANAGER), validate(bulkPriceSchema), asyncHandler(ctrl.bulkPrice));
