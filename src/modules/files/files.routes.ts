import { Router, Request, Response } from 'express';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL } from '../../middleware/rbacGuard';
import { ok } from '../../utils/response';
import { presignUploadSchema, presignDownloadSchema } from './files.validators';
import * as svc from './files.service';

const router = Router();

router.post(
  '/presign-upload',
  rbacGuard(ALL),
  validate(presignUploadSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await svc.presignUpload(req.auth!.tenantId, req.auth!.userId, req.body);
    return ok(res, result);
  }),
);

router.post(
  '/presign-download',
  rbacGuard(ALL),
  validate(presignDownloadSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await svc.presignDownload(req.body.key);
    return ok(res, result);
  }),
);

export default router;
