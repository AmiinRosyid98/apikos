import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

/**
 * PLAN B2.6 — 100 req/min/IP on public/auth routes. Redis is deferred to MVP-2; this uses
 * express-rate-limit's in-memory store (single-instance dev). Emits the §2.2 RATE_LIMITED
 * envelope. Swap the store for Redis when horizontal scaling lands (MVP-2 seam).
 */
export const publicRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Too many requests, please try again later.',
    });
  },
});
