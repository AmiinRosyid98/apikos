import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import * as svc from './finance.service';
import type {
  ListCategoriesQuery,
  ListExpensesQuery,
  CashflowQuery,
  SummaryQuery,
  PlQuery,
  ReconciliationQuery,
} from './finance.validators';

// ─────────────────────────── Expense categories ───────────────────────────
export async function listCategories(req: Request, res: Response) {
  const q = vquery<ListCategoriesQuery>(req);
  const { rows, total } = await svc.listCategories(req.auth!.tenantId, q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function createCategory(req: Request, res: Response) {
  const created = await svc.createCategory(req.auth!.tenantId, req.body);
  await writeAudit(req, {
    action: 'expense_category.create',
    entityType: 'expense_category',
    entityId: created.id,
    newValue: created,
  });
  return ok(res, created, 201);
}

export async function deleteCategory(req: Request, res: Response) {
  const result = await svc.deleteCategory(req.params.id);
  await writeAudit(req, {
    action: 'expense_category.delete',
    entityType: 'expense_category',
    entityId: result.id,
  });
  return ok(res, result);
}

// ─────────────────────────── Expenses ───────────────────────────
/** Property-scope guard for an expense (null property = tenant-wide overhead → allowed). */
async function guardExpenseScope(req: Request, propertyId: string | null) {
  if (propertyId) assertPropertyAccess(req, propertyId);
}

export async function listExpenses(req: Request, res: Response) {
  const q = vquery<ListExpensesQuery>(req);
  if (q.property_id) assertPropertyAccess(req, q.property_id);
  const { rows, total, totalAmount } = await svc.listExpenses(q, req.propertyScope);
  return res.status(200).json({
    success: true,
    data: { expenses: rows, totalAmount },
    meta: buildMeta(q.page, q.limit, total),
  });
}

export async function createExpense(req: Request, res: Response) {
  if (req.body.propertyId) assertPropertyAccess(req, req.body.propertyId);
  const created = await svc.createExpense(req.auth!.tenantId, req.auth!.userId, req.body);
  await writeAudit(req, {
    action: 'expense.create',
    entityType: 'expense',
    entityId: created.id,
    newValue: created,
  });
  return ok(res, created, 201);
}

export async function updateExpense(req: Request, res: Response) {
  // Guard the expense's current property; if moving to another property, guard that too.
  const currentPropertyId = await svc.getExpensePropertyId(req.params.id);
  await guardExpenseScope(req, currentPropertyId);
  if (req.body.propertyId) assertPropertyAccess(req, req.body.propertyId);

  const updated = await svc.updateExpense(req.params.id, req.body);
  await writeAudit(req, {
    action: 'expense.update',
    entityType: 'expense',
    entityId: updated.id,
    newValue: updated,
  });
  return ok(res, updated);
}

export async function deleteExpense(req: Request, res: Response) {
  const currentPropertyId = await svc.getExpensePropertyId(req.params.id);
  await guardExpenseScope(req, currentPropertyId);
  const result = await svc.deleteExpense(req.params.id);
  await writeAudit(req, {
    action: 'expense.delete',
    entityType: 'expense',
    entityId: result.id,
  });
  return ok(res, result);
}

// ─────────────────────────── Aggregations ───────────────────────────
export async function cashflow(req: Request, res: Response) {
  const q = vquery<CashflowQuery>(req);
  if (q.property_id) assertPropertyAccess(req, q.property_id);
  const data = await svc.cashflow(q, req.propertyScope);
  return ok(res, data);
}

export async function summary(req: Request, res: Response) {
  const q = vquery<SummaryQuery>(req);
  if (q.property_id) assertPropertyAccess(req, q.property_id);
  const data = await svc.summary(q, req.propertyScope);
  return ok(res, data);
}

export async function profitAndLoss(req: Request, res: Response) {
  const q = vquery<PlQuery>(req);
  if (q.property_id) assertPropertyAccess(req, q.property_id);
  const data = await svc.profitAndLoss(req.auth!.tenantId, q, req.propertyScope);
  return ok(res, data);
}

export async function reconciliation(req: Request, res: Response) {
  const q = vquery<ReconciliationQuery>(req);
  if (q.property_id) assertPropertyAccess(req, q.property_id);
  const data = await svc.reconciliation(q, req.propertyScope);
  return ok(res, data);
}
