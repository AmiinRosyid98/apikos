import { z } from 'zod';

const currentYear = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;

/** Shared optional period helpers. */
const monthField = z.coerce.number().int().min(1).max(12).default(currentMonth);
const yearField = z.coerce.number().int().min(2000).max(2100).default(currentYear);

// ─────────────────────────── JSON report query schemas ───────────────────────────
export const invoicesReportQuery = z.object({
  property_id: z.string().uuid().optional(),
  month: monthField,
  year: yearField,
});

export const residentsReportQuery = z.object({
  property_id: z.string().uuid().optional(),
  month: monthField,
  year: yearField,
});

export const occupancyReportQuery = z.object({
  property_id: z.string().uuid().optional(),
  months: z.coerce.number().int().refine((v) => v === 6 || v === 12, 'months must be 6 or 12').default(6),
});

export const revenueReportQuery = z.object({
  property_id: z.string().uuid().optional(),
  year: yearField,
});

export const roomTypesReportQuery = z.object({
  property_id: z.string().uuid().optional(),
});

// ─────────────────────────── Tax (PPh) & ROI report query schemas ───────────────────────────
/**
 * Laporan Pajak (PPh final 4(2) atas sewa). `rate` is the PPh rate as a fraction (0–1); the
 * default 0.10 is the Indonesian 10% final tax on rental income. `grossIncome` per month =
 * collected rental revenue (payments received), so PPh follows actual cash, not invoiced.
 */
export const taxReportQuery = z.object({
  property_id: z.string().uuid().optional(),
  year: yearField,
  rate: z.coerce.number().min(0).max(1).default(0.1),
});

/** Laporan ROI per properti for a year (revenue/expense collected/recorded in `year`). */
export const roiReportQuery = z.object({
  property_id: z.string().uuid().optional(),
  year: yearField,
});

// ─────────────────────────── Export query ───────────────────────────
export const REPORT_TYPES = ['invoices', 'residents', 'occupancy', 'revenue', 'room-types', 'tax', 'roi'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Export uses the path param `:type` plus the SUPERSET of all report params (each report
 * reads only the ones it needs). `months` defaults to 6, `month`/`year` to current.
 */
export const exportReportParams = z.object({
  type: z.enum(REPORT_TYPES),
});

export const exportReportQuery = z.object({
  property_id: z.string().uuid().optional(),
  month: monthField,
  year: yearField,
  months: z.coerce.number().int().refine((v) => v === 6 || v === 12, 'months must be 6 or 12').default(6),
  // Only consumed by the `tax` export; ignored by the other report types.
  rate: z.coerce.number().min(0).max(1).default(0.1),
});

export type InvoicesReportQuery = z.infer<typeof invoicesReportQuery>;
export type ResidentsReportQuery = z.infer<typeof residentsReportQuery>;
export type OccupancyReportQuery = z.infer<typeof occupancyReportQuery>;
export type RevenueReportQuery = z.infer<typeof revenueReportQuery>;
export type RoomTypesReportQuery = z.infer<typeof roomTypesReportQuery>;
export type TaxReportQuery = z.infer<typeof taxReportQuery>;
export type RoiReportQuery = z.infer<typeof roiReportQuery>;
export type ExportReportQuery = z.infer<typeof exportReportQuery>;
