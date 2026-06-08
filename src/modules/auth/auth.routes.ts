import { Router } from 'express';
import * as ctrl from './auth.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { authGuard } from '../../middleware/authGuard';
import { tenantContext } from '../../middleware/tenantContext';
import { publicRateLimiter } from '../../middleware/rateLimiter';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.validators';

const router = Router();

// Public auth routes are rate-limited (B2.6).
router.post('/register', publicRateLimiter, validate(registerSchema), asyncHandler(ctrl.register));
router.post('/login', publicRateLimiter, validate(loginSchema), asyncHandler(ctrl.login));
router.post('/refresh', publicRateLimiter, validate(refreshSchema), asyncHandler(ctrl.refresh));
router.post(
  '/forgot-password',
  publicRateLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(ctrl.forgotPassword),
);
router.post(
  '/reset-password',
  publicRateLimiter,
  validate(resetPasswordSchema),
  asyncHandler(ctrl.resetPassword),
);

// Authenticated.
router.post('/logout', authGuard, validate(logoutSchema), asyncHandler(ctrl.logout));
router.get('/me', authGuard, tenantContext, asyncHandler(ctrl.me));

export default router;
