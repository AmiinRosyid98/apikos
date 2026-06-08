import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { ok } from '../../utils/response';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL, OWNER_ONLY } from '../../middleware/rbacGuard';
import { getUsageAndLimits } from '../../services/plan.service';
import { writeAudit } from '../../services/audit.service';
import { Errors } from '../../utils/errors';

const router = Router();

// Plan caps for change-plan stub (MVP-1: updates caps only, no payment — A3).
const PLAN_CAPS: Record<string, { maxProperties: number; maxRooms: number; maxUsers: number }> = {
  basic: { maxProperties: 1, maxRooms: 20, maxUsers: 2 },
  pro: { maxProperties: 5, maxRooms: 150, maxUsers: 10 },
  premium: { maxProperties: 50, maxRooms: 2000, maxUsers: 100 },
};

const FEATURES: Record<string, Record<string, boolean>> = {
  basic: { whatsapp: false, paymentGateway: false, reports: false },
  pro: { whatsapp: true, paymentGateway: false, reports: true },
  premium: { whatsapp: true, paymentGateway: true, reports: true },
};

router.get(
  '/',
  rbacGuard(ALL),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await getUsageAndLimits(req.auth!.tenantId);
    return ok(res, { ...data, features: FEATURES[data.plan] ?? FEATURES.basic });
  }),
);

const changePlanSchema = z.object({ plan: z.enum(['basic', 'pro', 'premium']) });

router.post(
  '/change-plan',
  rbacGuard(OWNER_ONLY),
  validate(changePlanSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const plan = req.body.plan as keyof typeof PLAN_CAPS;
    const caps = PLAN_CAPS[plan];
    if (!caps) throw Errors.validation('Unknown plan');
    const updated = await prisma.tenant.update({
      where: { id: req.auth!.tenantId },
      data: {
        subscriptionPlan: plan as 'basic' | 'pro' | 'premium',
        subscriptionStatus: 'active',
        maxProperties: caps.maxProperties,
        maxRooms: caps.maxRooms,
        maxUsers: caps.maxUsers,
      },
    });
    await writeAudit(req, {
      action: 'subscription.change_plan',
      entityType: 'subscription',
      entityId: updated.id,
      newValue: { plan },
    });
    return ok(res, {
      plan: updated.subscriptionPlan,
      limits: caps,
      status: updated.subscriptionStatus,
    });
  }),
);

export default router;
