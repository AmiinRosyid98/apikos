import { Router } from 'express';
import * as ctrl from './reports.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL, FINANCE_PLUS, loadPropertyScope } from '../../middleware/rbacGuard';
import {
  invoicesReportQuery,
  residentsReportQuery,
  occupancyReportQuery,
  revenueReportQuery,
  roomTypesReportQuery,
  taxReportQuery,
  roiReportQuery,
  exportReportParams,
  exportReportQuery,
} from './reports.validators';

const router = Router();
router.use(loadPropertyScope);

// ── JSON report data endpoints — View = all roles (consistent with dashboard view-all) ──
router.get('/invoices', rbacGuard(ALL), validate(invoicesReportQuery, 'query'), asyncHandler(ctrl.invoices));
router.get('/residents', rbacGuard(ALL), validate(residentsReportQuery, 'query'), asyncHandler(ctrl.residents));
router.get('/occupancy', rbacGuard(ALL), validate(occupancyReportQuery, 'query'), asyncHandler(ctrl.occupancy));
router.get('/revenue', rbacGuard(ALL), validate(revenueReportQuery, 'query'), asyncHandler(ctrl.revenue));
router.get('/room-types', rbacGuard(ALL), validate(roomTypesReportQuery, 'query'), asyncHandler(ctrl.roomTypes));

// ── Tax (PPh) & ROI — owner/manager/finance only (admin → 403, like P&L); no plan gate on view ──
router.get('/tax', rbacGuard(FINANCE_PLUS), validate(taxReportQuery, 'query'), asyncHandler(ctrl.tax));
router.get('/roi', rbacGuard(FINANCE_PLUS), validate(roiReportQuery, 'query'), asyncHandler(ctrl.roi));

// ── Excel export — owner/manager/finance only (admin → 403); plan-gated Pro+ in the controller ──
// Route shape: GET /reports/:type/export.xlsx  (type ∈ invoices|residents|occupancy|revenue|room-types)
router.get(
  '/:type/export.xlsx',
  rbacGuard(FINANCE_PLUS),
  validate(exportReportParams, 'params'),
  validate(exportReportQuery, 'query'),
  asyncHandler(ctrl.exportXlsx),
);

export default router;
