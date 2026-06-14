import { env } from '../../../config/env';
import type { PaymentProvider } from './provider';
import { StubProvider } from './stub.provider';
import { MidtransProvider } from './midtrans.provider';

/**
 * Payment-gateway provider factory (PRD §6.8 seam). Picks Midtrans IFF a MIDTRANS_SERVER_KEY is
 * configured, else Stub. Key presence is the single switch — going live is config-only (set the
 * server/client keys + restart). We never hit the network without credentials.
 *
 * The instance is memoized; call `resetPaymentProvider()` in tests if env changes mid-process.
 */
let cached: PaymentProvider | undefined;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;

  const keySet = Boolean(env.MIDTRANS_SERVER_KEY && env.MIDTRANS_SERVER_KEY.trim().length > 0);
  cached = keySet
    ? new MidtransProvider(env.MIDTRANS_SERVER_KEY, env.MIDTRANS_IS_PRODUCTION)
    : new StubProvider();
  return cached;
}

/** True when a real provider (Midtrans) is wired (server key present). */
export function isProviderConfigured(): boolean {
  return getPaymentProvider().name === 'midtrans';
}

/** Reset the memoized provider (tests / hot config reload). */
export function resetPaymentProvider(): void {
  cached = undefined;
}
