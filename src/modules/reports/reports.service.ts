import { Prisma, InvoiceStatus } from '@prisma/client';
import { prisma } from '../../config/database';
import { dateOnly } from '../../utils/serialize';
import type {
  InvoicesReportQuery,
  ResidentsReportQuery,
  OccupancyReportQuery,
  RevenueReportQuery,
  RoomTypesReportQuery,
  TaxReportQuery,
  RoiReportQuery,
} from './reports.validators';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** First day of a month (UTC) → first day of next month — a half-open range. */
function monthRange(year: number, month: number) {
  return {
    gte: new Date(Date.UTC(year, month - 1, 1)),
    lt: new Date(Date.UTC(year, month, 1)),
  };
}

function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ─────────────────────────── Property-scope helper ───────────────────────────
/**
 * Resolve the effective property filter for an aggregation given the caller's property scope
 * allowlist (undefined = unrestricted). A restricted caller asking for an out-of-scope property
 * gets a sentinel that matches nothing (no existence leak). Mirrors finance.service.
 */
export function resolvePropertyFilter(
  requested: string | undefined,
  scope: string[] | undefined,
): { propertyId?: string | { in: string[] } } {
  if (scope === undefined) {
    return requested ? { propertyId: requested } : {};
  }
  if (requested) {
    return scope.includes(requested)
      ? { propertyId: requested }
      : { propertyId: { in: ['__none__'] } };
  }
  return { propertyId: { in: scope } };
}

/** Build an Invoice where-clause for the property filter (for payment scoping via invoice). */
function invoiceScopeFromProp(propFilter: {
  propertyId?: string | { in: string[] };
}): Prisma.InvoiceWhereInput | undefined {
  if (propFilter.propertyId === undefined) return undefined;
  return { propertyId: propFilter.propertyId };
}

/** Human label for the property scope of a report header. */
export async function propertyLabel(
  requested: string | undefined,
  _scope: string[] | undefined,
): Promise<string> {
  if (requested) {
    const p = await prisma.property.findFirst({ where: { id: requested }, select: { name: true } });
    return p?.name ?? 'Semua Properti';
  }
  return 'Semua Properti';
}

// ═══════════════════════════ 1. Invoices report ═══════════════════════════
export interface InvoicesReport {
  totalInvoiced: number;
  totalPaid: number;
  totalOutstanding: number;
  countByStatus: Record<'unpaid' | 'partial' | 'paid' | 'overdue' | 'cancelled', number>;
  rows: {
    invoiceNumber: string;
    residentName: string;
    roomNumber: string | null;
    period: string;
    total: number;
    paid: number;
    status: InvoiceStatus;
    dueDate: string | null;
  }[];
}

/**
 * Invoices report for a billing period (periodMonth/periodYear). Totals + per-status counts +
 * a row per invoice. Outstanding = total − paid over non-cancelled invoices.
 */
export async function invoicesReport(
  q: InvoicesReportQuery,
  scope: string[] | undefined,
): Promise<InvoicesReport> {
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const where: Prisma.InvoiceWhereInput = {
    periodMonth: q.month,
    periodYear: q.year,
    ...propFilter,
  };

  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      resident: { select: { fullName: true } },
      room: { select: { roomNumber: true } },
    },
    orderBy: [{ invoiceNumber: 'asc' }],
  });

  const countByStatus = { unpaid: 0, partial: 0, paid: 0, overdue: 0, cancelled: 0 };
  let totalInvoiced = 0;
  let totalPaid = 0;
  let totalOutstanding = 0;

  const rows = invoices.map((inv) => {
    const total = Number(inv.totalAmount);
    const paid = Number(inv.paidAmount);
    countByStatus[inv.status] += 1;
    // Cancelled invoices are excluded from money totals (consistent with finance).
    if (inv.status !== 'cancelled') {
      totalInvoiced += total;
      totalPaid += paid;
      totalOutstanding += total - paid;
    }
    return {
      invoiceNumber: inv.invoiceNumber,
      residentName: inv.resident?.fullName ?? '—',
      roomNumber: inv.room?.roomNumber ?? null,
      period: monthLabel(inv.periodYear, inv.periodMonth),
      total: round2(total),
      paid: round2(paid),
      status: inv.status,
      dueDate: dateOnly(inv.dueDate),
    };
  });

  return {
    totalInvoiced: round2(totalInvoiced),
    totalPaid: round2(totalPaid),
    totalOutstanding: round2(totalOutstanding),
    countByStatus,
    rows,
  };
}

// ═══════════════════════════ 2. Residents report ═══════════════════════════
export interface ResidentsReport {
  movedIn: number;
  movedOut: number;
  active: number;
  rows: {
    name: string;
    roomNumber: string | null;
    status: string;
    checkInDate: string | null;
    checkOutDate: string | null;
  }[];
}

/**
 * Residents report. `movedIn`/`movedOut` are counted within the period (check-in / check-out
 * date falling inside the month). `active` = residents currently `active`. Rows list all
 * residents in scope.
 */
export async function residentsReport(
  q: ResidentsReportQuery,
  scope: string[] | undefined,
): Promise<ResidentsReport> {
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const range = monthRange(q.year, q.month);

  const residents = await prisma.resident.findMany({
    where: { ...propFilter },
    include: { room: { select: { roomNumber: true } } },
    orderBy: [{ fullName: 'asc' }],
  });

  let movedIn = 0;
  let movedOut = 0;
  let active = 0;

  const rows = residents.map((r) => {
    if (r.status === 'active') active += 1;
    if (r.checkInDate && r.checkInDate >= range.gte && r.checkInDate < range.lt) movedIn += 1;
    if (r.checkOutDate && r.checkOutDate >= range.gte && r.checkOutDate < range.lt) movedOut += 1;
    return {
      name: r.fullName,
      roomNumber: r.room?.roomNumber ?? null,
      status: r.status,
      checkInDate: dateOnly(r.checkInDate),
      checkOutDate: dateOnly(r.checkOutDate),
    };
  });

  return { movedIn, movedOut, active, rows };
}

// ═══════════════════════════ 3. Occupancy trend report ═══════════════════════════
export interface OccupancyTrendRow {
  month: string;
  totalRooms: number;
  occupied: number;
  rate: number;
}

/**
 * Occupancy trend over the last N (6|12) months. For each month: occupied = occupancies whose
 * window overlaps that month (startDate < nextMonth AND (endDate is null OR endDate >= month
 * start)); rate = occupied / totalRooms. totalRooms is the CURRENT room count in scope (room
 * history isn't snapshotted — documented; same approach as the dashboard trend).
 */
export async function occupancyReport(
  q: OccupancyReportQuery,
  scope: string[] | undefined,
): Promise<OccupancyTrendRow[]> {
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const totalRooms = await prisma.room.count({ where: { ...propFilter } });

  const now = new Date();
  const rows: OccupancyTrendRow[] = [];
  for (let i = q.months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const occupied = await prisma.occupancy.count({
      where: {
        ...propFilter,
        startDate: { lt: next },
        OR: [{ endDate: null }, { endDate: { gte: d } }],
      },
    });
    rows.push({
      month: monthLabel(d.getUTCFullYear(), d.getUTCMonth() + 1),
      totalRooms,
      occupied,
      rate: totalRooms > 0 ? round2((occupied / totalRooms) * 100) : 0,
    });
  }
  return rows;
}

// ═══════════════════════════ 4. Revenue report ═══════════════════════════
export interface RevenueReportRow {
  month: string;
  realized: number;
  target: number;
}
export interface RevenueReport {
  year: number;
  rows: RevenueReportRow[];
  totalRealized: number;
  totalTarget: number;
}

/**
 * 12-month revenue report for a year.
 *   realized = SUM(payments.amount) with paidAt in that month (actual cash received).
 *   target   = SUM(monthlyRent of occupancies ACTIVE during that month) — the expected rent
 *              roll for the month. An occupancy is "active during the month" when it overlaps
 *              the month window (startDate < nextMonth AND (endDate is null OR endDate >= month
 *              start)). This is the documented definition of "target".
 */
export async function revenueReport(
  q: RevenueReportQuery,
  scope: string[] | undefined,
): Promise<RevenueReport> {
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const invoiceFilter = invoiceScopeFromProp(propFilter);

  const rows: RevenueReportRow[] = [];
  let totalRealized = 0;
  let totalTarget = 0;

  for (let m = 1; m <= 12; m++) {
    const range = monthRange(q.year, m);
    const next = range.lt;

    const [realizedAgg, occupancies] = await Promise.all([
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { paidAt: range, ...(invoiceFilter ? { invoice: invoiceFilter } : {}) },
      }),
      prisma.occupancy.findMany({
        where: {
          ...propFilter,
          startDate: { lt: next },
          OR: [{ endDate: null }, { endDate: { gte: range.gte } }],
        },
        select: { monthlyRent: true },
      }),
    ]);

    const realized = round2(Number(realizedAgg._sum.amount ?? 0));
    const target = round2(occupancies.reduce((s, o) => s + Number(o.monthlyRent), 0));
    totalRealized += realized;
    totalTarget += target;
    rows.push({ month: monthLabel(q.year, m), realized, target });
  }

  return {
    year: q.year,
    rows,
    totalRealized: round2(totalRealized),
    totalTarget: round2(totalTarget),
  };
}

// ═══════════════════════════ 5. Room-types report ═══════════════════════════
export interface RoomTypeRow {
  roomType: string;
  count: number;
  occupied: number;
  occupancyRate: number;
  revenue: number;
}

/**
 * Performance per room type (PRD "performa per tipe kamar"). For each room type in scope:
 *   count          = number of rooms of that type.
 *   occupied       = rooms of that type currently in status `occupied`.
 *   occupancyRate  = occupied / count.
 *   revenue        = SUM(payments) on invoices for rooms of that type (this calendar year).
 */
export async function roomTypesReport(
  q: RoomTypesReportQuery,
  scope: string[] | undefined,
): Promise<RoomTypeRow[]> {
  const propFilter = resolvePropertyFilter(q.property_id, scope);

  const rooms = await prisma.room.findMany({
    where: { ...propFilter },
    select: { id: true, roomType: true, status: true },
  });

  // Revenue per room (payments on invoices belonging to the room) for the current year.
  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const yearEnd = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1));
  const roomIds = rooms.map((r) => r.id);
  const revenueByRoom = new Map<string, number>();
  if (roomIds.length) {
    const payments = await prisma.payment.findMany({
      where: { paidAt: { gte: yearStart, lt: yearEnd }, invoice: { roomId: { in: roomIds } } },
      select: { amount: true, invoice: { select: { roomId: true } } },
    });
    for (const p of payments) {
      const rid = p.invoice?.roomId;
      if (!rid) continue;
      revenueByRoom.set(rid, (revenueByRoom.get(rid) ?? 0) + Number(p.amount));
    }
  }

  const byType = new Map<string, RoomTypeRow>();
  for (const r of rooms) {
    const row = byType.get(r.roomType) ?? {
      roomType: r.roomType,
      count: 0,
      occupied: 0,
      occupancyRate: 0,
      revenue: 0,
    };
    row.count += 1;
    if (r.status === 'occupied') row.occupied += 1;
    row.revenue += revenueByRoom.get(r.id) ?? 0;
    byType.set(r.roomType, row);
  }

  return [...byType.values()]
    .map((row) => ({
      ...row,
      revenue: round2(row.revenue),
      occupancyRate: row.count > 0 ? round2((row.occupied / row.count) * 100) : 0,
    }))
    .sort((a, b) => a.roomType.localeCompare(b.roomType));
}

// ═══════════════════════════ 6. Tax (PPh) report ═══════════════════════════
export interface TaxReportRow {
  month: string;
  grossIncome: number;
  pphEstimate: number;
}
export interface TaxReport {
  year: number;
  rate: number;
  rows: TaxReportRow[];
  totalGross: number;
  totalPph: number;
}

/**
 * Indonesian rental-income PPh recap (PPh final pasal 4 ayat 2 atas sewa, default rate 10%).
 *   grossIncome (per month) = COLLECTED rental revenue = SUM(payments.amount) with paidAt in that
 *     month. We use collected cash (payments received), NOT invoiced amounts — PPh final on rental
 *     income follows actual receipts. (Documented choice; same payments ledger the dashboard uses.)
 *   pphEstimate = grossIncome × rate (rate is a fraction, e.g. 0.10).
 * Per-property when `property_id` is given (scoped via invoice.propertyId), else aggregate over the
 * caller's whole property scope. 12 monthly rows + yearly totals.
 */
export async function taxReport(
  q: TaxReportQuery,
  scope: string[] | undefined,
): Promise<TaxReport> {
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const invoiceFilter = invoiceScopeFromProp(propFilter);
  const rate = q.rate;

  const rows: TaxReportRow[] = [];
  let totalGross = 0;
  let totalPph = 0;

  for (let m = 1; m <= 12; m++) {
    const range = monthRange(q.year, m);
    const agg = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paidAt: range, ...(invoiceFilter ? { invoice: invoiceFilter } : {}) },
    });
    const grossIncome = round2(Number(agg._sum.amount ?? 0));
    const pphEstimate = round2(grossIncome * rate);
    totalGross += grossIncome;
    totalPph += pphEstimate;
    rows.push({ month: monthLabel(q.year, m), grossIncome, pphEstimate });
  }

  return {
    year: q.year,
    rate,
    rows,
    totalGross: round2(totalGross),
    totalPph: round2(totalPph),
  };
}

// ═══════════════════════════ 7. ROI report ═══════════════════════════
export interface RoiReportRow {
  propertyId: string;
  propertyName: string;
  investmentValue: number | null;
  revenue: number;
  expense: number;
  netIncome: number;
  roiPercent: number | null;
  paybackYears: number | null;
}
export interface RoiReport {
  year: number;
  rows: RoiReportRow[];
  totals: {
    investmentValue: number | null;
    revenue: number;
    expense: number;
    netIncome: number;
    roiPercent: number | null;
    paybackYears: number | null;
  };
}

/** revenue = collected payments in the year for a property; expense = expenses recorded that year. */
async function roiPropertyFigures(propertyId: string, year: number) {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
  const [revenueAgg, expenseAgg] = await Promise.all([
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paidAt: { gte: yearStart, lt: yearEnd }, invoice: { propertyId } },
    }),
    prisma.expense.aggregate({
      _sum: { amount: true },
      where: { date: { gte: yearStart, lt: yearEnd }, propertyId },
    }),
  ]);
  return {
    revenue: round2(Number(revenueAgg._sum.amount ?? 0)),
    expense: round2(Number(expenseAgg._sum.amount ?? 0)),
  };
}

function roiMetrics(investmentValue: number | null, netIncome: number) {
  const hasInvestment = investmentValue !== null && investmentValue > 0;
  const roiPercent = hasInvestment ? round2((netIncome / investmentValue) * 100) : null;
  // Payback only meaningful with positive net income and a recorded investment.
  const paybackYears =
    hasInvestment && netIncome > 0 ? round2(investmentValue / netIncome) : null;
  return { roiPercent, paybackYears };
}

/**
 * ROI per property for a year (PRD §6.12 tambahan, §19). For each property in scope:
 *   investmentValue = property.investmentValue (acquisition/investment cost; null if not set).
 *   revenue         = collected payments (paidAt in the year) on the property's invoices.
 *   expense         = expenses recorded (date in the year) against the property.
 *   netIncome       = revenue − expense.
 *   roiPercent      = investmentValue>0 ? netIncome / investmentValue × 100 : null.
 *   paybackYears    = (netIncome>0 && investmentValue>0) ? investmentValue / netIncome : null.
 * Null/zero investment → roiPercent/paybackYears null (UI shows "atur nilai investasi").
 * A single property (when `property_id` given) returns one row; otherwise a row per property in
 * scope plus an aggregate `totals` block (investmentValue total is null if NO property has one).
 */
export async function roiReport(
  q: RoiReportQuery,
  scope: string[] | undefined,
): Promise<RoiReport> {
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const where: Prisma.PropertyWhereInput = {};
  if (propFilter.propertyId !== undefined) where.id = propFilter.propertyId;

  const properties = await prisma.property.findMany({
    where,
    select: { id: true, name: true, investmentValue: true },
    orderBy: { name: 'asc' },
  });

  const rows: RoiReportRow[] = [];
  let totalInvestmentRaw = 0;
  let anyInvestment = false;
  let totalRevenue = 0;
  let totalExpense = 0;

  for (const p of properties) {
    const investmentValue = p.investmentValue === null ? null : round2(Number(p.investmentValue));
    const { revenue, expense } = await roiPropertyFigures(p.id, q.year);
    const netIncome = round2(revenue - expense);
    const { roiPercent, paybackYears } = roiMetrics(investmentValue, netIncome);

    if (investmentValue !== null) {
      anyInvestment = true;
      totalInvestmentRaw += investmentValue;
    }
    totalRevenue += revenue;
    totalExpense += expense;

    rows.push({
      propertyId: p.id,
      propertyName: p.name,
      investmentValue,
      revenue,
      expense,
      netIncome,
      roiPercent,
      paybackYears,
    });
  }

  const totalInvestment = anyInvestment ? round2(totalInvestmentRaw) : null;
  const totalRevenueR = round2(totalRevenue);
  const totalExpenseR = round2(totalExpense);
  const totalNet = round2(totalRevenueR - totalExpenseR);
  const totalMetrics = roiMetrics(totalInvestment, totalNet);

  return {
    year: q.year,
    rows,
    totals: {
      investmentValue: totalInvestment,
      revenue: totalRevenueR,
      expense: totalExpenseR,
      netIncome: totalNet,
      roiPercent: totalMetrics.roiPercent,
      paybackYears: totalMetrics.paybackYears,
    },
  };
}
