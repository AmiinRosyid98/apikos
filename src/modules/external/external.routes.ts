import { Router } from 'express';
import cors from 'cors';
import { apiKeyAuth, requireScope } from '../../middleware/apiKeyAuth';
import { apiKeyRateLimiter } from '../../middleware/rateLimiter';
import { registerUuidParams, validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { createBookingSchema } from '../bookings/bookings.validators';
import {
  extListQuery,
  extRoomListQuery,
  extResidentListQuery,
  extInvoiceListQuery,
  extBookingListQuery,
} from './external.validators';
import * as ctrl from './external.controller';

/**
 * EXTERNAL / Public API router (PRD Modul 22). Mounted OUTSIDE the JWT-protected dashboard router
 * at /api/ext/v1 (see app.ts). Auth = API key (apiKeyAuth) — NOT a JWT. Premium-only (enforced in
 * apiKeyAuth via the plan gate). Read-focused + scope-enforced + tenant-scoped. Returns the SAME
 * serialized shapes as the dashboard API. NIK is NEVER decrypted here (masked nikLast4 only).
 *
 * Middleware order: permissive CORS (third-party clients) → apiKeyAuth (sets req.apiAuth + tenant
 * context) → per-KEY rate limiter (120/min/key, separate from the global IP limiter) → UUID param
 * validation → per-route scope guard → handler.
 */
const externalRouter = Router();

// Third-party clients call from arbitrary origins; the API is credential-less (key in a header),
// so permissive CORS is appropriate here (the dashboard keeps its strict allowlist).
externalRouter.use(cors({ origin: true, credentials: false }));

externalRouter.use(apiKeyAuth);
externalRouter.use(apiKeyRateLimiter);
registerUuidParams(externalRouter);

// Connectivity / introspection — no scope required (any valid key).
externalRouter.get('/me', asyncHandler(ctrl.me));

// Properties (properties:read)
externalRouter.get(
  '/properties',
  requireScope('properties:read'),
  validate(extListQuery, 'query'),
  asyncHandler(ctrl.listPropertiesExt),
);
externalRouter.get(
  '/properties/:id',
  requireScope('properties:read'),
  asyncHandler(ctrl.getPropertyExt),
);

// Rooms (rooms:read)
externalRouter.get(
  '/rooms',
  requireScope('rooms:read'),
  validate(extRoomListQuery, 'query'),
  asyncHandler(ctrl.listRoomsExt),
);
externalRouter.get('/rooms/:id', requireScope('rooms:read'), asyncHandler(ctrl.getRoomExt));

// Residents (residents:read) — NIK never decrypted (masked nikLast4 only)
externalRouter.get(
  '/residents',
  requireScope('residents:read'),
  validate(extResidentListQuery, 'query'),
  asyncHandler(ctrl.listResidentsExt),
);
externalRouter.get(
  '/residents/:id',
  requireScope('residents:read'),
  asyncHandler(ctrl.getResidentExt),
);

// Invoices (invoices:read)
externalRouter.get(
  '/invoices',
  requireScope('invoices:read'),
  validate(extInvoiceListQuery, 'query'),
  asyncHandler(ctrl.listInvoicesExt),
);
externalRouter.get(
  '/invoices/:id',
  requireScope('invoices:read'),
  asyncHandler(ctrl.getInvoiceExt),
);

// Bookings (bookings:read + bookings:write)
externalRouter.get(
  '/bookings',
  requireScope('bookings:read'),
  validate(extBookingListQuery, 'query'),
  asyncHandler(ctrl.listBookingsExt),
);
externalRouter.get(
  '/bookings/:id',
  requireScope('bookings:read'),
  asyncHandler(ctrl.getBookingExt),
);
externalRouter.post(
  '/bookings',
  requireScope('bookings:write'),
  validate(createBookingSchema),
  asyncHandler(ctrl.createBookingExt),
);

export { externalRouter };
