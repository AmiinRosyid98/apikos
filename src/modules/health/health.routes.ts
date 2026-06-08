import { Router, Request, Response } from 'express';
import { prisma } from '../../config/database';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    let db = 'down';
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }
    return ok(res, {
      status: 'ok',
      service: 'kosmanager-api',
      version: '0.1.0',
      db,
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
