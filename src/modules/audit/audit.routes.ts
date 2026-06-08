import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { okPaged, buildMeta } from '../../utils/response';
import { validate, vquery } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, OWNER_MANAGER } from '../../middleware/rbacGuard';
import { iso } from '../../utils/serialize';

const router = Router();

const listAuditQuery = z.object({
  action: z.string().optional(),
  entity_type: z.string().optional(),
  user_id: z.string().uuid().optional(),
  from: z.string().datetime().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  to: z.string().datetime().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});
type ListAuditQuery = z.infer<typeof listAuditQuery>;

// Read-only. Owner = full; Manager = view-only (§13). No create/update/delete routes (immutable).
router.get(
  '/',
  rbacGuard(OWNER_MANAGER),
  validate(listAuditQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = vquery<ListAuditQuery>(req);
    const where: Prisma.AuditLogWhereInput = {};
    if (q.action) where.action = q.action;
    if (q.entity_type) where.entityType = q.entity_type;
    if (q.user_id) where.userId = q.user_id;
    if (q.from || q.to) {
      where.createdAt = {};
      if (q.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(q.from);
      if (q.to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(q.to);
    }

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: q.sort_order },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    const data = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      oldValue: r.oldValue,
      newValue: r.newValue,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      createdAt: iso(r.createdAt),
    }));
    return okPaged(res, data, buildMeta(q.page, q.limit, total));
  }),
);

export default router;
