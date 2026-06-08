import { z } from 'zod';

/** §2.1 pagination/sort query params. page>=1, limit 1..100 (default 20). */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort_by: z.string().optional(),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export function toSkipTake(p: { page: number; limit: number }) {
  return { skip: (p.page - 1) * p.limit, take: p.limit };
}

/** Build a Prisma orderBy from sort_by/sort_order, restricted to an allowlist of columns. */
export function buildOrderBy(
  sortBy: string | undefined,
  sortOrder: 'asc' | 'desc',
  allowed: string[],
  fallback = 'createdAt',
): Record<string, 'asc' | 'desc'> {
  const col = sortBy && allowed.includes(sortBy) ? sortBy : fallback;
  return { [col]: sortOrder };
}
