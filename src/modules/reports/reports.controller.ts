import { Request, Response } from 'express';
import { ok } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { assertPlanFeature } from '../../services/plan.service';
import { writeAudit } from '../../services/audit.service';
import * as svc from './reports.service';
import { buildReportExcel } from './reports.excel';
import type {
  InvoicesReportQuery,
  ResidentsReportQuery,
  OccupancyReportQuery,
  RevenueReportQuery,
  RoomTypesReportQuery,
  TaxReportQuery,
  RoiReportQuery,
  ExportReportQuery,
  ReportType,
} from './reports.validators';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Guard an explicit property_id against the caller's property scope. */
function guardProperty(req: Request, propertyId: string | undefined) {
  if (propertyId) assertPropertyAccess(req, propertyId);
}

// ─────────────────────────── JSON report endpoints (view = all roles) ───────────────────────────
export async function invoices(req: Request, res: Response) {
  const q = vquery<InvoicesReportQuery>(req);
  guardProperty(req, q.property_id);
  return ok(res, await svc.invoicesReport(q, req.propertyScope));
}

export async function residents(req: Request, res: Response) {
  const q = vquery<ResidentsReportQuery>(req);
  guardProperty(req, q.property_id);
  return ok(res, await svc.residentsReport(q, req.propertyScope));
}

export async function occupancy(req: Request, res: Response) {
  const q = vquery<OccupancyReportQuery>(req);
  guardProperty(req, q.property_id);
  return ok(res, await svc.occupancyReport(q, req.propertyScope));
}

export async function revenue(req: Request, res: Response) {
  const q = vquery<RevenueReportQuery>(req);
  guardProperty(req, q.property_id);
  return ok(res, await svc.revenueReport(q, req.propertyScope));
}

export async function roomTypes(req: Request, res: Response) {
  const q = vquery<RoomTypesReportQuery>(req);
  guardProperty(req, q.property_id);
  return ok(res, await svc.roomTypesReport(q, req.propertyScope));
}

// ── Tax (PPh) & ROI — view gated to owner/manager/finance (admin → 403, like P&L) ──
export async function tax(req: Request, res: Response) {
  const q = vquery<TaxReportQuery>(req);
  guardProperty(req, q.property_id);
  return ok(res, await svc.taxReport(q, req.propertyScope));
}

export async function roi(req: Request, res: Response) {
  const q = vquery<RoiReportQuery>(req);
  guardProperty(req, q.property_id);
  return ok(res, await svc.roiReport(q, req.propertyScope));
}

// ─────────────────────────── Excel export (owner/manager/finance + Pro+) ───────────────────────────
/**
 * Stream a report as .xlsx. Route base-gate is FINANCE_PLUS (admin → 403). Plan-gated Pro+ via
 * `assertPlanFeature('reports')` (Basic → 403). Audited as `report.export`.
 */
export async function exportXlsx(req: Request, res: Response) {
  const type = req.params.type as ReportType;
  const q = vquery<ExportReportQuery>(req);
  guardProperty(req, q.property_id);

  // Plan gate (Pro+). Basic → 403 FORBIDDEN.
  await assertPlanFeature(req.auth!.tenantId, 'reports');

  const { buffer, filename } = await buildReportExcel(type, q, req.propertyScope);

  await writeAudit(req, {
    action: 'report.export',
    entityType: 'report',
    entityId: type,
    newValue: { type, property_id: q.property_id ?? null, month: q.month, year: q.year, months: q.months, rate: q.rate },
  });

  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).end(buffer);
}
