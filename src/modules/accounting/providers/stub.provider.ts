import { randomUUID } from 'crypto';
import type {
  AccountingProvider,
  AccountingEntryPayload,
  PushEntryResult,
  TestConnectionResult,
} from './provider';

/**
 * StubProvider — DEFAULT when no real accounting provider+key is configured (PRD Modul 21, STUB
 * MODE). Never touches the network: logs a structured line and returns status `synced` with a fake
 * `JRN-STUB-…` reference so the UI can show the journal was "posted" in demo mode. `testConnection`
 * always succeeds. This mirrors the WhatsApp/Payment StubProviders.
 */
export class StubProvider implements AccountingProvider {
  readonly name = 'stub' as const;

  async pushEntry(entry: AccountingEntryPayload): Promise<PushEntryResult> {
    const ref = `JRN-STUB-${randomUUID().slice(0, 8).toUpperCase()}`;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        evt: 'accounting.stub.push',
        provider: 'stub',
        entityType: entry.entityType,
        entityId: entry.entityId,
        entryType: entry.entryType,
        amount: entry.amount,
        ref,
      }),
    );
    return { ref, status: 'synced' };
  }

  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'Stub accounting provider active (demo mode — no entries are really posted).' };
  }
}
