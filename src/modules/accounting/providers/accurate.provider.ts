import type {
  AccountingProvider,
  AccountingEntryPayload,
  PushEntryResult,
  TestConnectionResult,
} from './provider';

/**
 * AccurateProvider — the REAL Accurate Online journal poster (PRD Modul 21), used only when the
 * tenant's `accountingProvider === 'accurate'` AND a decrypted API key is supplied.
 *
 * Accurate Open API shape (https://account.accurate.id, indicative):
 *   POST {baseUrl}/accurate/api/journal-voucher/save.do
 *   Headers: { Authorization: "Bearer <apiToken>", "X-Session-ID": "<session>" }
 *   Body (form/json): { transDate, description, detailJournal: [ { accountName, debitAmount,
 *            creditAmount }, … ] }
 *   Success: { s: true, r: { number } } → we use r.number as the ref.
 *
 * Working skeleton, intentionally lightly tested (no token/session here). The POINT of the seam is
 * the config-only swap (the factory selects this class once provider='accurate' + a key exist).
 * NOTE: Accurate also needs a session id (`X-Session-ID`) obtained from the host DB selection; the
 * single encrypted key is treated as the bearer token here — a richer credential blob is a noted
 * seam (store the session alongside the token when wiring live). Verify against the live API.
 *
 * `pushEntry` / `testConnection` NEVER throw — failures become a `failed` result.
 */
const DEFAULT_BASE_URL = 'https://account.accurate.id';

export class AccurateProvider implements AccountingProvider {
  readonly name = 'accurate' as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async pushEntry(entry: AccountingEntryPayload): Promise<PushEntryResult> {
    try {
      const res = await fetch(`${this.baseUrl}/accurate/api/journal-voucher/save.do`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transDate: entry.date,
          description: entry.memo,
          detailJournal: entry.lines.map((l) => ({
            accountName: l.account,
            debitAmount: l.debit,
            creditAmount: l.credit,
          })),
        }),
      });

      const json = (await res.json().catch(() => ({}))) as {
        s?: boolean;
        r?: { id?: string | number; number?: string };
        d?: string[] | string;
      };

      if (!res.ok || json.s !== true || !json.r) {
        const detail = Array.isArray(json.d) ? json.d.join('; ') : json.d;
        return { ref: '', status: 'failed', error: detail || `Accurate HTTP ${res.status}` };
      }

      const ref = json.r.number ?? String(json.r.id ?? '') ?? '';
      return { ref, status: 'synced' };
    } catch (e) {
      return { ref: '', status: 'failed', error: (e as Error).message };
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const res = await fetch(`${this.baseUrl}/accurate/api/company.do`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        return { ok: false, message: `Accurate connection failed: HTTP ${res.status}` };
      }
      return { ok: true, message: 'Accurate Online connection OK.' };
    } catch (e) {
      return { ok: false, message: `Accurate connection error: ${(e as Error).message}` };
    }
  }
}
