import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

/**
 * PLAN B2.6 — 100 req/min/IP on public/auth routes. Redis is deferred to MVP-2; this uses
 * express-rate-limit's in-memory store (single-instance dev). Emits the §2.2 RATE_LIMITED
 * envelope. Swap the store for Redis when horizontal scaling lands (MVP-2 seam).
 */
const rateLimitedResponse = (_req: unknown, res: any) => {
  res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many requests, please try again later.',
  });
};

export const publicRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/**
 * Anti-spam limiter for the UNAUTHENTICATED public landing READ (PRD §6.2). Looser than the booking
 * POST but stricter than nothing — protects the open `GET /public/properties/:slug` from scraping.
 * Default 60 requests / 5 min / IP (env PUBLIC_READ_RATE_LIMIT_MAX / PUBLIC_RATE_LIMIT_WINDOW_MS).
 */
export const publicReadRateLimiter = rateLimit({
  windowMs: env.PUBLIC_RATE_LIMIT_WINDOW_MS,
  max: env.PUBLIC_READ_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/**
 * STRICT anti-spam limiter for the UNAUTHENTICATED public booking SUBMISSION (PRD §6.13). A public
 * booking is a write that creates a lead + can reserve a room, so it is the highest-abuse surface.
 * Default 5 submissions / hour / IP (env PUBLIC_BOOKING_RATE_LIMIT_MAX / PUBLIC_BOOKING_RATE_LIMIT_WINDOW_MS).
 * In-memory store (single-instance dev); swap for Redis when scaling (same seam as publicRateLimiter).
 */
export const publicBookingRateLimiter = rateLimit({
  windowMs: env.PUBLIC_BOOKING_RATE_LIMIT_WINDOW_MS,
  max: env.PUBLIC_BOOKING_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/**
 * PER-API-KEY rate limiter for the Public API (PRD Modul 22). SEPARATE from the global IP limiter
 * (publicRateLimiter) — keyed by the resolved API key id (set by apiKeyAuth) so each tenant key
 * gets its own budget regardless of source IP. Default 120 req / min / key (env-configurable).
 * Mounted AFTER apiKeyAuth so req.apiAuth.apiKeyId is available; falls back to IP if (unexpectedly)
 * the key context is missing. In-memory store (single-instance dev) — same Redis seam as the others.
 */
export const apiKeyRateLimiter = rateLimit({
  windowMs: env.API_KEY_RATE_LIMIT_WINDOW_MS,
  max: env.API_KEY_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.apiAuth?.apiKeyId ?? req.ip ?? 'unknown',
  handler: rateLimitedResponse,
});
