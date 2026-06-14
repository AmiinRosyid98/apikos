/**
 * Accounting provider seam (PRD Modul 21 — Integrasi Akuntansi). The CRITICAL abstraction: every
 * sync path (POST /accounting/sync, testConnection) goes through accounting.service → an
 * `AccountingProvider`. Swapping the real provider in (Jurnal.id / Accurate) is a CONFIG change
 * only — set the tenant's `accountingProvider` + an encrypted `accountingApiKeyEnc` and the factory
 * returns the matching provider; no caller changes.
 *
 *   - StubProvider     (DEFAULT, no real provider+key): never touches the network; returns a FAKE
 *     `JRN-STUB-…` journal ref + status `synced`. `testConnection` always { ok:true }.
 *   - JurnalProvider   (skeleton, used only when provider='jurnal' + key set): real Jurnal.id REST
 *     shape (Bearer token), structured but lightly exercised. `pushEntry` NEVER throws → failures
 *     become status:'failed'.
 *   - AccurateProvider (skeleton, used only when provider='accurate' + key set): real Accurate
 *     Open API shape (Bearer + session header). Same never-throw contract.
 *
 * Mirrors the WhatsApp (`providers/`) and Payment (`providers/`) seams exactly.
 */

/** A single journal line of the mapped double-entry. Exactly one of debit/credit is non-zero. */
export interface JournalLine {
  /** Chart-of-accounts name (see mapping.ts CHART_OF_ACCOUNTS). */
  account: string;
  debit: number;
  credit: number;
}

/** Provider-agnostic journal entry to push (built by mapping.ts). */
export interface AccountingEntryPayload {
  /** Our local entity reference: which source row produced this journal. */
  entityType: 'payment' | 'expense';
  entityId: string;
  entryType: 'income' | 'expense';
  amount: number;
  /** Human-readable journal memo (e.g. "Penerimaan sewa INV-2026-000002 — Budi Santoso"). */
  memo: string;
  /** ISO date the transaction occurred (payment.paidAt / expense.date). */
  date: string;
  /** The balanced double-entry lines (debit total === credit total). */
  lines: JournalLine[];
}

export interface PushEntryResult {
  /** External journal reference from the provider (Stub → "JRN-STUB-…"). */
  ref: string;
  status: 'synced' | 'failed';
  /** Failure detail (when status === 'failed'). */
  error?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

export interface AccountingProvider {
  /** Stable provider name for logs + the status endpoint + the entry rows. */
  readonly name: 'stub' | 'jurnal' | 'accurate';
  /**
   * Push one mapped journal entry to the provider. NEVER throws — a network/parse/auth failure
   * returns { status:'failed', error }. The Stub fabricates a ref without any network call.
   */
  pushEntry(entry: AccountingEntryPayload): Promise<PushEntryResult>;
  /** Probe the provider/credentials. NEVER throws. Stub → always ok. */
  testConnection(): Promise<TestConnectionResult>;
}
