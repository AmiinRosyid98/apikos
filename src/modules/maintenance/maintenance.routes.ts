import { Router } from 'express';
import * as ctrl from './maintenance.controller';
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
  createTicketSchema,
  updateTicketSchema,
  ticketStatusSchema,
  listTicketQuery,
  createVendorSchema,
  updateVendorSchema,
  listVendorQuery,
  roomMaintenanceQuery,
} from './maintenance.validators';

/**
 * Maintenance Module routes (PRD §6.14). RBAC (PRD §13 — Maintenance rows):
 *   Tickets: add/edit/assign/close (create/PUT/status) → Admin+ (owner/manager/admin); finance ❌.
 *            view all (list/detail) → ALL roles (incl. finance).
 *   Vendors: manage (create/edit) → Admin+; delete → Manager+; view (list/detail) → ALL.
 * No plan gate (maintenance is not in the §12.2 plan matrix → available on all plans).
 *
 * INTERNAL only — the public tenant-submitted-report link is DEFERRED (see the PUBLIC REPORT SEAM
 * in maintenance.service.ts).
 */

// ── /api/v1/maintenance (tickets) ──
export const maintenanceRouter = Router();
maintenanceRouter.use(loadPropertyScope);

maintenanceRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listTicketQuery, 'query'),
  asyncHandler(ctrl.listTickets),
);
maintenanceRouter.post(
  '/',
  rbacGuard(ADMIN_PLUS),
  validate(createTicketSchema),
  asyncHandler(ctrl.createTicket),
);
maintenanceRouter.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.ticketDetail));
maintenanceRouter.put(
  '/:id',
  rbacGuard(ADMIN_PLUS),
  validate(updateTicketSchema),
  asyncHandler(ctrl.updateTicket),
);
maintenanceRouter.patch(
  '/:id/status',
  rbacGuard(ADMIN_PLUS),
  validate(ticketStatusSchema),
  asyncHandler(ctrl.changeStatus),
);

// ── /api/v1/vendors ──
export const vendorsRouter = Router();
vendorsRouter.use(loadPropertyScope);

vendorsRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listVendorQuery, 'query'),
  asyncHandler(ctrl.listVendors),
);
vendorsRouter.post(
  '/',
  rbacGuard(ADMIN_PLUS),
  validate(createVendorSchema),
  asyncHandler(ctrl.createVendor),
);
vendorsRouter.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.vendorDetail));
vendorsRouter.put(
  '/:id',
  rbacGuard(ADMIN_PLUS),
  validate(updateVendorSchema),
  asyncHandler(ctrl.updateVendor),
);
vendorsRouter.delete('/:id', rbacGuard(MANAGER_PLUS), asyncHandler(ctrl.deleteVendor));

// ── Nested per-room history: /api/v1/rooms/:id/maintenance (mergeParams to read :id) ──
export const roomMaintenanceRouter = Router({ mergeParams: true });
roomMaintenanceRouter.use(loadPropertyScope);
roomMaintenanceRouter.get(
  '/',
  rbacGuard(ALL),
  validate(roomMaintenanceQuery, 'query'),
  asyncHandler(ctrl.listTicketsByRoom),
);
