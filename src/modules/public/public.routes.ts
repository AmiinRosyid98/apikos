import { Router } from 'express';
import cors from 'cors';
import * as ctrl from './public.controller';
import { validate, validateParams } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { publicReadRateLimiter, publicBookingRateLimiter } from '../../middleware/rateLimiter';
import { slugParamSchema, publicBookingSchema } from './public.validators';

/**
 * PUBLIC router (PRD §6.2 landing publik, §6.13 link booking publik).
 *
 * MOUNTED OUTSIDE the protected/auth router (like POST /webhooks/payment) — NO authGuard, NO
 * tenantContext JWT middleware. The tenant + property are resolved STRICTLY from the URL slug inside
 * the service (which then runs every read/write inside runWithTenant). The body NEVER carries a
 * tenantId/propertyId (the strict Zod schema rejects unknown keys).
 *
 * CORS: these endpoints are intended to be hit from the public marketing site (a different origin
 * than the dashboard), so this router is PERMISSIVE (any origin) — they expose only marketing-safe,
 * non-sensitive data and accept no credentials. The rest of the API keeps the strict CORS allowlist.
 *
 * Anti-spam: the landing READ is rate-limited (publicReadRateLimiter); the booking SUBMISSION has a
 * stricter per-IP limiter (publicBookingRateLimiter, default 5/hour) PLUS a honeypot in the controller.
 */
const publicRouter = Router();

// Permissive CORS for the public surface only (any origin, no credentials).
publicRouter.use(cors({ origin: true, credentials: false }));

// GET marketing-safe property + available (empty) rooms + price range. Rate-limited.
publicRouter.get(
  '/properties/:slug',
  publicReadRateLimiter,
  validateParams(slugParamSchema),
  asyncHandler(ctrl.getProperty),
);

// POST a public booking submission. STRICT rate limit + honeypot + strict body validation.
publicRouter.post(
  '/properties/:slug/bookings',
  publicBookingRateLimiter,
  validateParams(slugParamSchema),
  validate(publicBookingSchema),
  asyncHandler(ctrl.createBooking),
);

export { publicRouter };
