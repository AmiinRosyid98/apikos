import type { AccountingEntryPayload, JournalLine } from './providers/provider';

/**
 * Journal mapping (PRD Modul 21 — Integrasi Akuntansi). Maps a KosManager transaction to a balanced
 * double-entry journal that a provider (Jurnal.id / Accurate / Stub) can post.
 *
 * ── Chart of accounts (simple, cash-basis) ──────────────────────────────────────────────────────
 * We use a minimal, indonesian-named chart so the posted journals are immediately legible. A future
 * iteration can let a tenant map these names to their own provider account ids (noted seam).
 *
 *   "Kas/Bank"             — asset (cash/bank). Debited on income, credited on expense.
 *   "Pendapatan Sewa"      — revenue (rental income). Credited on a received payment.
 *   "Beban {Kategori}"     — expense by category, e.g. "Beban Listrik PLN", "Beban Maintenance".
 *                            Defaults to "Beban Operasional" when no category name is available.
 *
 * ── Double-entry rules ──────────────────────────────────────────────────────────────────────────
 *   Payment received (income):  DEBIT  Kas/Bank          = amount
 *                               CREDIT Pendapatan Sewa   = amount
 *   Expense (expense):          DEBIT  Beban {Kategori}   = amount
 *                               CREDIT Kas/Bank           = amount
 *
 * Every produced journal is BALANCED (sum of debits === sum of credits === amount).
 */

export const CHART_OF_ACCOUNTS = {
  cashBank: 'Kas/Bank',
  rentalRevenue: 'Pendapatan Sewa',
  /** Expense account name from a category (e.g. "Beban Listrik PLN"). */
  expenseAccount(categoryName?: string | null): string {
    const name = (categoryName ?? '').trim();
    return name ? `Beban ${name}` : 'Beban Operasional';
  },
} as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Assert (in dev) that a journal balances — throws would be too harsh in prod, so we just clamp. */
export function isBalanced(lines: JournalLine[]): boolean {
  const debit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round2(lines.reduce((s, l) => s + l.credit, 0));
  return debit === credit;
}

export interface PaymentForMapping {
  id: string;
  amount: number;
  paidAt: Date;
  invoiceNumber?: string | null;
  residentName?: string | null;
}

export interface ExpenseForMapping {
  id: string;
  amount: number;
  date: Date;
  categoryName?: string | null;
  description?: string | null;
}

/**
 * Map a received Payment → income journal:
 *   DEBIT Kas/Bank, CREDIT Pendapatan Sewa.
 */
export function mapPaymentToEntry(p: PaymentForMapping): AccountingEntryPayload {
  const amount = round2(p.amount);
  const lines: JournalLine[] = [
    { account: CHART_OF_ACCOUNTS.cashBank, debit: amount, credit: 0 },
    { account: CHART_OF_ACCOUNTS.rentalRevenue, debit: 0, credit: amount },
  ];
  const ref = p.invoiceNumber ? ` ${p.invoiceNumber}` : '';
  const who = p.residentName ? ` — ${p.residentName}` : '';
  return {
    entityType: 'payment',
    entityId: p.id,
    entryType: 'income',
    amount,
    memo: `Penerimaan sewa${ref}${who}`,
    date: p.paidAt.toISOString().slice(0, 10),
    lines,
  };
}

/**
 * Map an Expense → expense journal:
 *   DEBIT Beban {Kategori}, CREDIT Kas/Bank.
 */
export function mapExpenseToEntry(e: ExpenseForMapping): AccountingEntryPayload {
  const amount = round2(e.amount);
  const account = CHART_OF_ACCOUNTS.expenseAccount(e.categoryName);
  const lines: JournalLine[] = [
    { account, debit: amount, credit: 0 },
    { account: CHART_OF_ACCOUNTS.cashBank, debit: 0, credit: amount },
  ];
  const desc = e.description ? ` — ${e.description}` : '';
  return {
    entityType: 'expense',
    entityId: e.id,
    entryType: 'expense',
    amount,
    memo: `${account}${desc}`,
    date: e.date.toISOString().slice(0, 10),
    lines,
  };
}
