import { Router, Request, Response } from 'express';
import { ok } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL, loadPropertyScope, assertPropertyAccess } from '../../middleware/rbacGuard';
import * as svc from './dashboard.service';

const router = Router();
router.use(loadPropertyScope);

router.get(
  '/overview',
  rbacGuard(ALL),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await svc.overview(req.propertyScope);
    return ok(res, data);
  }),
);

router.get(
  '/properties/:id',
  rbacGuard(ALL),
  asyncHandler(async (req: Request, res: Response) => {
    assertPropertyAccess(req, req.params.id);
    const data = await svc.propertyDashboard(req.params.id);
    return ok(res, data);
  }),
);

export default router;
