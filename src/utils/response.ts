import { Response } from 'express';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** §2.1 success envelope. */
export function ok(res: Response, data: unknown, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

/** §2.1 success envelope with pagination meta. */
export function okPaged(res: Response, data: unknown[], meta: PageMeta, status = 200): Response {
  return res.status(status).json({ success: true, data, meta });
}

export function buildMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
