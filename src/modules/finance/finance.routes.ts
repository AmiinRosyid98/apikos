import { Router } from 'express';
import * as ctrl from './finance.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  rbacGuard,
  ALL,
  ADMIN_PLUS,
  MANAGER_PLUS,
  FINANCE_PLUS,
  loadPropertyScope,
} from '../../middleware/rbacGuard';
import {
  createCategorySchema,
  listCategoriesQuery,
  createExpenseSchema,
  updateExpenseSchema,
  listExpensesQuery,
  cashflowQuery,
  summaryQuery,
  plQuery,
  reconciliationQuery,
} from './finance.validators';

// All finance routes are property-scope aware.
const router = Router();
router.use(loadPropertyScope);

// ── Expense categories ──
// GET (All) · POST (Manager+) · DELETE (owner/manager).
router.get(
  '/expense-categories',
  rbacGuard(ALL),
  validate(listCategoriesQuery, 'query'),
  asyncHandler(ctrl.listCategories),
);
router.post(
  '/expense-categories',
  rbacGuard(MANAGER_PLUS),
  validate(createCategorySchema),
  asyncHandler(ctrl.createCategory),
);
router.delete(
  '/expense-categories/:id',
  rbacGuard(MANAGER_PLUS),
  asyncHandler(ctrl.deleteCategory),
);

// ── Expenses ──
// GET (All) · POST (All) · PUT (Admin+) · DELETE (owner/manager only — admin/finance → 403).
router.get(
  '/expenses',
  rbacGuard(ALL),
  validate(listExpensesQuery, 'query'),
  asyncHandler(ctrl.listExpenses),
);
router.post(
  '/expenses',
  rbacGuard(ALL),
  validate(createExpenseSchema),
  asyncHandler(ctrl.createExpense),
);
router.put(
  '/expenses/:id',
  rbacGuard(ADMIN_PLUS),
  validate(updateExpenseSchema),
  asyncHandler(ctrl.updateExpense),
);
router.delete('/expenses/:id', rbacGuard(MANAGER_PLUS), asyncHandler(ctrl.deleteExpense));

// ── Cash flow / Summary (All) ──
router.get('/cashflow', rbacGuard(ALL), validate(cashflowQuery, 'query'), asyncHandler(ctrl.cashflow));
router.get('/summary', rbacGuard(ALL), validate(summaryQuery, 'query'), asyncHandler(ctrl.summary));

// ── P&L (owner/manager/finance; admin 403) — Plan-gated Pro+ via `reports` feature ──
router.get('/pl', rbacGuard(FINANCE_PLUS), validate(plQuery, 'query'), asyncHandler(ctrl.profitAndLoss));

// ── Reconciliation (owner/manager/finance) ──
router.get(
  '/reconciliation',
  rbacGuard(FINANCE_PLUS),
  validate(reconciliationQuery, 'query'),
  asyncHandler(ctrl.reconciliation),
);

export default router;
