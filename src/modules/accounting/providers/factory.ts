import { env } from '../../../config/env';
import { decryptNullable } from '../../../utils/crypto';
import type { AccountingProvider } from './provider';
import { StubProvider } from './stub.provider';
import { JurnalProvider } from './jurnal.provider';
import { AccurateProvider } from './accurate.provider';

/**
 * Accounting provider factory (PRD Modul 21 seam). UNLIKE the WhatsApp/Payment factories (which key
 * off a single process-wide env var), accounting config is PER-TENANT — each tenant stores its own
 * `accountingProvider` ('stub'|'jurnal'|'accurate') + an encrypted `accountingApiKeyEnc`. So the
 * factory is called WITH the tenant's config; it is NOT memoized (a tenant could change config).
 *
 * Selection rule (the single switch — going live is config-only):
 *   - provider 'jurnal'  + a non-empty key → JurnalProvider  (real skeleton)
 *   - provider 'accurate'+ a non-empty key → AccurateProvider (real skeleton)
 *   - anything else (provider unset/'stub', or a real provider WITHOUT a key) → StubProvider
 *
 * We NEVER hit the network without credentials: a real provider name with no key falls back to Stub.
 * `ACCOUNTING_PROVIDER` (env, default empty) is an optional process-wide default applied when a
 * tenant has not chosen a provider — it still requires a key to use a real provider.
 */
export interface TenantAccountingConfig {
  accountingProvider: string | null;
  accountingApiKeyEnc: string | null;
}

export function getAccountingProvider(config: TenantAccountingConfig): AccountingProvider {
  const provider = (config.accountingProvider || env.ACCOUNTING_PROVIDER || '').trim().toLowerCase();
  const apiKey = decryptNullable(config.accountingApiKeyEnc); // null when unset/undecryptable

  if (provider === 'jurnal' && apiKey) return new JurnalProvider(apiKey);
  if (provider === 'accurate' && apiKey) return new AccurateProvider(apiKey);

  // Default / no key → Stub (no network, demo mode).
  return new StubProvider();
}

/** True when a real provider (jurnal/accurate) is wired for this tenant (provider + key present). */
export function isProviderConfigured(config: TenantAccountingConfig): boolean {
  return getAccountingProvider(config).name !== 'stub';
}
