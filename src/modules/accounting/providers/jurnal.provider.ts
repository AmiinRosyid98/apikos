import type {
  AccountingProvider,
  AccountingEntryPayload,
  PushEntryResult,
  TestConnectionResult,
} from './provider';

/**
 * JurnalProvider — the REAL Jurnal.id (Mekari) journal poster (PRD Modul 21), used only when the
 * tenant's `accountingProvider === 'jurnal'` AND a decrypted API key is supplied.
 *
 * Jurnal.id REST shape (https://api.jurnal.id, indicative):
 *   POST {baseUrl}/core/api/v1/manual_journals
 *   Headers: { Authorization: "Bearer <apiKey>", Content-Type: "application/json" }
 *   Body: { manual_journal: { transaction_date, memo, transaction_lines_attributes: [
 *            { account_name, debit, credit }, … ] } }
 *   Success: 201 { manual_journal: { id, transaction_no } } → we use transaction_no as the ref.
 *
 * This is a working skeleton, intentionally lightly tested (no key/sandbox here). The POINT of the
 * seam is that switching to it is a config-only swap (the factory selects this class once the tenant
 * config has provider='jurnal' + a key). Verify the request/response shapes against the live API
 * once a key exists.
 *
 * `pushEntry` / `testConnection` NEVER throw — network/parse/auth failures become a `failed` result
 * so the sync loop records a `failed` accounting_entries row instead of crashing.
 */
const DEFAULT_BASE_URL = 'https://api.jurnal.id';

export class JurnalProvider implements AccountingProvider {
  readonly name = 'jurnal' as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async pushEntry(entry: AccountingEntryPayload): Promise<PushEntryResult> {
    try {
      const res = await fetch(`${this.baseUrl}/core/api/v1/manual_journals`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manual_journal: {
            transaction_date: entry.date,
            memo: entry.memo,
            transaction_lines_attributes: entry.lines.map((l) => ({
              account_name: l.account,
              debit: l.debit,
              credit: l.credit,
            })),
          },
        }),
      });

      const json = (await res.json().catch(() => ({}))) as {
        manual_journal?: { id?: string | number; transaction_no?: string };
        message?: string;
        error?: string;
      };

      if (!res.ok || !json.manual_journal) {
        return {
          ref: '',
          status: 'failed',
          error: json.message || json.error || `Jurnal HTTP ${res.status}`,
        };
      }

      const ref =
        json.manual_journal.transaction_no ?? String(json.manual_journal.id ?? '') ?? '';
      return { ref, status: 'synced' };
    } catch (e) {
      return { ref: '', status: 'failed', error: (e as Error).message };
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const res = await fetch(`${this.baseUrl}/core/api/v1/account_categories`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        return { ok: false, message: `Jurnal connection failed: HTTP ${res.status}` };
      }
      return { ok: true, message: 'Jurnal.id connection OK.' };
    } catch (e) {
      return { ok: false, message: `Jurnal connection error: ${(e as Error).message}` };
    }
  }
}
