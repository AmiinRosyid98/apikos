import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, dateOnly, iso } from '../../utils/serialize';
import { assertPlanFeature } from '../../services/plan.service';
import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  CreateExpenseInput,
  UpdateExpenseInput,
  ListExpensesQuery,
  CashflowQuery,
  SummaryQuery,
  PlQuery,
  ReconciliationQuery,
} from './finance.validators';

type ExpenseRow = Prisma.ExpenseGetPayload<{ include: { category: true; property: true } }>;
type CategoryRow = Prisma.ExpenseCategoryGetPayload<object>;

const DEFAULT_CATEGORY_NAMES = [
  'Listrik PLN',
  'Internet',
  'Kebersihan',
  'Maintenance',
  'Gaji/Upah',
  'Lainnya',
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** First day of a month (UTC) and the first day of the next month — a half-open range. */
function monthRange(year: number, month: number) {
  return {
    gte: new Date(Date.UTC(year, month - 1, 1)),
    lt: new Date(Date.UTC(year, month, 1)),
  };
}

function yearRange(year: number) {
  return {
    gte: new Date(Date.UTC(year, 0, 1)),
    lt: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

// ─────────────────────────── Serializers ───────────────────────────
export function serializeCategory(c: CategoryRow) {
  return {
    id: c.id,
    name: c.name,
    isDefault: c.isDefault,
    createdAt: iso(c.createdAt),
  };
}

export function serializeExpense(e: ExpenseRow) {
  return {
    id: e.id,
    propertyId: e.propertyId,
    propertyName: e.property?.name ?? null,
    categoryId: e.categoryId,
    categoryName: e.category?.name ?? null,
    amount: dec(e.amount),
    date: dateOnly(e.date),
    description: e.description,
    vendorName: e.vendorName,
    receiptKey: e.receiptKey,
    recordedByUserId: e.recordedByUserId,
    createdAt: iso(e.createdAt),
  };
}

// ─────────────────────────── Property-scope helper ───────────────────────────
/**
 * Resolve the effective propertyId filter for a list/aggregation given the caller's
 * property scope allowlist (undefined = unrestricted). When a restricted caller asks for a
 * property outside their scope, returns a sentinel that matches nothing (no existence leak).
 */
function resolvePropertyFilter(
  requested: string | undefined,
  scope: string[] | undefined,
): { propertyId?: string | { in: string[] } } {
  if (scope === undefined) {
    return requested ? { propertyId: requested } : {};
  }
  if (requested) {
    return scope.includes(requested) ? { propertyId: requested } : { propertyId: { in: ['__none__'] } };
  }
  return { propertyId: { in: scope } };
}

async function getProperty(id: string) {
  const p = await prisma.property.findFirst({ where: { id } });
  if (!p) throw Errors.notFound('Property not found');
  return p;
}

// ─────────────────────────── Expense categories ───────────────────────────
/**
 * Lazily seed the per-tenant default categories on first fetch if none exist yet. Defensive:
 * the seed script also creates them for the demo tenant, but tenants created via registration
 * get them here on first use.
 */
async function ensureDefaultCategories(tenantId: string): Promise<void> {
  const count = await prisma.expenseCategory.count();
  if (count > 0) return;
  for (const name of DEFAULT_CATEGORY_NAMES) {
    await prisma.expenseCategory
      .create({ data: { tenantId, name, isDefault: true } })
      .catch(() => undefined); // ignore races / duplicates
  }
}

export async function listCategories(tenantId: string, q: ListCategoriesQuery) {
  await ensureDefaultCategories(tenantId);
  const [rows, total] = await Promise.all([
    prisma.expenseCategory.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: q.sort_order }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.expenseCategory.count(),
  ]);
  return { rows: rows.map(serializeCategory), total };
}

export async function createCategory(tenantId: string, input: CreateCategoryInput) {
  const name = input.name.trim();
  try {
    const created = await prisma.expenseCategory.create({
      data: { tenantId, name, isDefault: false },
    });
    return serializeCategory(created);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw Errors.conflict(`A category named "${name}" already exists`);
    }
    throw e;
  }
}

export async function getCategory(id: string): Promise<CategoryRow> {
  const c = await prisma.expenseCategory.findFirst({ where: { id } });
  if (!c) throw Errors.notFound('Expense category not found');
  return c;
}

/**
 * Delete a category. Blocked (409) if any expenses still reference it — the caller must
 * reassign those expenses first. Default categories cannot be deleted (422).
 */
export async function deleteCategory(id: string): Promise<{ id: string }> {
  const cat = await getCategory(id);
  if (cat.isDefault) {
    throw Errors.validation('Default categories cannot be deleted');
  }
  const inUse = await prisma.expense.count({ where: { categoryId: id } });
  if (inUse > 0) {
    throw Errors.conflict(
      `Category is in use by ${inUse} expense(s); reassign those expenses to another category before deleting`,
    );
  }
  await prisma.expenseCategory.delete({ where: { id } });
  return { id };
}

// ─────────────────────────── Expenses ───────────────────────────
async function getExpense(id: string): Promise<ExpenseRow> {
  const e = await prisma.expense.findFirst({
    where: { id },
    include: { category: true, property: true },
  });
  if (!e) throw Errors.notFound('Expense not found');
  return e;
}

/** Resolve the property an expense belongs to (null for tenant-wide overhead). */
export async function getExpensePropertyId(id: string): Promise<string | null> {
  return (await getExpense(id)).propertyId;
}

export async function listExpenses(q: ListExpensesQuery, scope: string[] | undefined) {
  const where: Prisma.ExpenseWhereInput = { ...resolvePropertyFilter(q.property_id, scope) };
  if (q.category_id) where.categoryId = q.category_id;
  if (q.date_from || q.date_to) {
    where.date = {};
    if (q.date_from) (where.date as Prisma.DateTimeFilter).gte = new Date(`${q.date_from}T00:00:00.000Z`);
    if (q.date_to) (where.date as Prisma.DateTimeFilter).lte = new Date(`${q.date_to}T00:00:00.000Z`);
  }

  const [rows, total, totals] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: { category: true, property: true },
      orderBy: [{ date: q.sort_order }, { createdAt: q.sort_order }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
  ]);
  return { rows: rows.map(serializeExpense), total, totalAmount: dec(totals._sum.amount) ?? 0 };
}

export async function createExpense(
  tenantId: string,
  userId: string,
  input: CreateExpenseInput,
) {
  // Category must belong to the tenant.
  await getCategory(input.categoryId);
  if (input.propertyId) await getProperty(input.propertyId);

  const created = await prisma.expense.create({
    data: {
      tenantId,
      propertyId: input.propertyId ?? null,
      categoryId: input.categoryId,
      amount: input.amount,
      date: new Date(`${input.date}T00:00:00.000Z`),
      description: input.description,
      vendorName: input.vendorName,
      receiptKey: input.receiptKey,
      recordedByUserId: userId,
    },
    include: { category: true, property: true },
  });
  return serializeExpense(created);
}

export async function updateExpense(id: string, input: UpdateExpenseInput) {
  const existing = await getExpense(id);
  if (input.categoryId) await getCategory(input.categoryId);
  if (input.propertyId) await getProperty(input.propertyId);

  const data: Prisma.ExpenseUpdateInput = {};
  if (input.categoryId !== undefined) data.category = { connect: { id: input.categoryId } };
  if (input.propertyId !== undefined) {
    data.property = input.propertyId ? { connect: { id: input.propertyId } } : { disconnect: true };
  }
  if (input.amount !== undefined) data.amount = input.amount;
  if (input.date !== undefined) data.date = new Date(`${input.date}T00:00:00.000Z`);
  if (input.description !== undefined) data.description = input.description;
  if (input.vendorName !== undefined) data.vendorName = input.vendorName;
  if (input.receiptKey !== undefined) data.receiptKey = input.receiptKey;

  const updated = await prisma.expense.update({
    where: { id: existing.id },
    data,
    include: { category: true, property: true },
  });
  return serializeExpense(updated);
}

export async function deleteExpense(id: string): Promise<{ id: string }> {
  const existing = await getExpense(id);
  await prisma.expense.delete({ where: { id: existing.id } });
  return { id: existing.id };
}

// ─────────────────────────── Cash flow ───────────────────────────
/**
 * 12-month cash flow for a year. income = SUM(payments.paidAt in month); expense =
 * SUM(expenses.date in month). Property scope honored (income via invoice.propertyId).
 */
export async function cashflow(q: CashflowQuery, scope: string[] | undefined) {
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const invoiceFilter = invoiceScopeFromProp(propFilter);

  const months: { month: number; income: number; expense: number; net: number }[] = [];
  for (let m = 1; m <= 12; m++) {
    const range = monthRange(q.year, m);
    const [incomeAgg, expenseAgg] = await Promise.all([
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { paidAt: range, ...(invoiceFilter ? { invoice: invoiceFilter } : {}) },
      }),
      prisma.expense.aggregate({
        _sum: { amount: true },
        where: { date: range, ...propFilter },
      }),
    ]);
    const income = round2(Number(incomeAgg._sum.amount ?? 0));
    const expense = round2(Number(expenseAgg._sum.amount ?? 0));
    months.push({ month: m, income, expense, net: round2(income - expense) });
  }
  return months;
}

/** Build an Invoice where-clause from the resolved property filter (for payment scoping). */
function invoiceScopeFromProp(
  propFilter: { propertyId?: string | { in: string[] } },
): Prisma.InvoiceWhereInput | undefined {
  if (propFilter.propertyId === undefined) return undefined;
  return { propertyId: propFilter.propertyId };
}

// ─────────────────────────── Summary ───────────────────────────
/**
 * Period summary: income (payments received), expense (expenses), net, plus the reconciliation
 * trio (invoiced/collected/outstanding) for the same month.
 */
export async function summary(q: SummaryQuery, scope: string[] | undefined) {
  const range = monthRange(q.year, q.month);
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const invoiceFilter = invoiceScopeFromProp(propFilter);

  const [incomeAgg, expenseAgg, invoicedAgg, collectedAgg] = await Promise.all([
    // income = actual cash received this month (payments)
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paidAt: range, ...(invoiceFilter ? { invoice: invoiceFilter } : {}) },
    }),
    // expense = expenses recorded this month
    prisma.expense.aggregate({ _sum: { amount: true }, where: { date: range, ...propFilter } }),
    // invoiced = total billed for invoices of this period
    prisma.invoice.aggregate({
      _sum: { totalAmount: true },
      where: { periodMonth: q.month, periodYear: q.year, status: { not: 'cancelled' }, ...invoiceFilter },
    }),
    // collected = paid amount on invoices of this period
    prisma.invoice.aggregate({
      _sum: { paidAmount: true },
      where: { periodMonth: q.month, periodYear: q.year, status: { not: 'cancelled' }, ...invoiceFilter },
    }),
  ]);

  const income = round2(Number(incomeAgg._sum.amount ?? 0));
  const expense = round2(Number(expenseAgg._sum.amount ?? 0));
  const invoiced = round2(Number(invoicedAgg._sum.totalAmount ?? 0));
  const collected = round2(Number(collectedAgg._sum.paidAmount ?? 0));

  return {
    income,
    expense,
    net: round2(income - expense),
    invoiced,
    collected,
    outstanding: round2(invoiced - collected),
  };
}

// ─────────────────────────── Profit & Loss (Pro+) ───────────────────────────
/**
 * P&L per property (or aggregate when no property_id). Plan-gated (`reports`).
 *   revenue           = SUM(payments received in the year) — actual cash.
 *   expensesByCategory= SUM(expenses in the year) grouped by category.
 *   netProfit         = revenue − totalExpense.
 */
export async function profitAndLoss(tenantId: string, q: PlQuery, scope: string[] | undefined) {
  await assertPlanFeature(tenantId, 'reports');

  const range = yearRange(q.year);
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const invoiceFilter = invoiceScopeFromProp(propFilter);

  const [revenueAgg, expenseGroups, categories] = await Promise.all([
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paidAt: range, ...(invoiceFilter ? { invoice: invoiceFilter } : {}) },
    }),
    prisma.expense.groupBy({
      by: ['categoryId'],
      where: { date: range, ...propFilter },
      _sum: { amount: true },
    }),
    prisma.expenseCategory.findMany({ select: { id: true, name: true } }),
  ]);

  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const expensesByCategory = expenseGroups
    .map((g) => ({
      category: nameById.get(g.categoryId) ?? 'Unknown',
      amount: round2(Number(g._sum.amount ?? 0)),
    }))
    .sort((a, b) => b.amount - a.amount);

  const totalExpense = round2(expensesByCategory.reduce((s, c) => s + c.amount, 0));
  const revenue = round2(Number(revenueAgg._sum.amount ?? 0));

  return {
    revenue,
    expensesByCategory,
    totalExpense,
    netProfit: round2(revenue - totalExpense),
  };
}

// ─────────────────────────── Reconciliation ───────────────────────────
/**
 * Rekonsiliasi (PRD): total tagihan (invoiced) vs total penerimaan (collected) for a period.
 *   totalInvoiced   = SUM(invoice.totalAmount) for the period (excluding cancelled).
 *   totalCollected  = SUM(invoice.paidAmount)  for the period.
 *   totalOutstanding= invoiced − collected.
 *   diff            = invoiced − collected (positive = under-collected).
 */
export async function reconciliation(q: ReconciliationQuery, scope: string[] | undefined) {
  const propFilter = resolvePropertyFilter(q.property_id, scope);
  const invoiceFilter = invoiceScopeFromProp(propFilter);

  const agg = await prisma.invoice.aggregate({
    _sum: { totalAmount: true, paidAmount: true },
    where: {
      periodMonth: q.month,
      periodYear: q.year,
      status: { not: 'cancelled' },
      ...invoiceFilter,
    },
  });

  const totalInvoiced = round2(Number(agg._sum.totalAmount ?? 0));
  const totalCollected = round2(Number(agg._sum.paidAmount ?? 0));
  const totalOutstanding = round2(totalInvoiced - totalCollected);

  return {
    totalInvoiced,
    totalCollected,
    totalOutstanding,
    diff: totalOutstanding,
  };
}
