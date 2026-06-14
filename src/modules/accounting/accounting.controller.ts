import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { writeAudit } from '../../services/audit.service';
import * as svc from './accounting.service';
import type { ListEntriesQuery, SyncInput } from './accounting.validators';

// ── GET /accounting/status (owner/manager/finance) ──
export async function status(req: Request, res: Response) {
  const data = await svc.getStatus(req.auth!.tenantId);
  return ok(res, data);
}

// ── PUT /accounting/config (Owner-only, Premium-gated) ──
export async function updateConfig(req: Request, res: Response) {
  const data = await svc.updateConfig(req.auth!.tenantId, req.body);
  await writeAudit(req, {
    action: 'accounting.config_update',
    entityType: 'tenant',
    entityId: req.auth!.tenantId,
    newValue: {
      provider: data.provider,
      enabled: data.enabled,
      apiKeySet: data.apiKeySet,
      // never log the key itself
    },
  });
  return ok(res, data);
}

// ── POST /accounting/sync (owner/manager/finance) ──
export async function sync(req: Request, res: Response) {
  const input = (req.body ?? {}) as SyncInput;
  const data = await svc.sync(req.auth!.tenantId, input, req.propertyScope);
  await writeAudit(req, {
    action: 'accounting.sync',
    entityType: 'accounting',
    entityId: req.auth!.tenantId,
    newValue: { synced: data.synced, skipped: data.skipped, failed: data.failed, total: data.total },
  });
  return ok(res, data);
}

// ── GET /accounting/entries (owner/manager/finance) ──
export async function listEntries(req: Request, res: Response) {
  const q = vquery<ListEntriesQuery>(req);
  const { rows, total } = await svc.listEntries(q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}
