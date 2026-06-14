import { env } from '../../../config/env';
import type { WhatsAppProvider } from './provider';
import { StubProvider } from './stub.provider';
import { FonnteProvider } from './fonnte.provider';

/**
 * Provider factory (PRD §6.9 seam). Picks Fonnte IFF a FONNTE_TOKEN is configured, else Stub.
 * Token presence is the single switch — going live is config-only (set FONNTE_TOKEN). WA_PROVIDER
 * is an explicit override knob, but it still requires a token to actually use Fonnte (so we never
 * try to hit the network without credentials).
 *
 * The instance is memoized; call `resetWhatsAppProvider()` in tests if env changes mid-process.
 */
let cached: WhatsAppProvider | undefined;

export function getWhatsAppProvider(): WhatsAppProvider {
  if (cached) return cached;

  const tokenSet = Boolean(env.FONNTE_TOKEN && env.FONNTE_TOKEN.trim().length > 0);
  const wantFonnte = tokenSet && env.WA_PROVIDER !== 'stub';

  cached = wantFonnte ? new FonnteProvider(env.FONNTE_TOKEN) : new StubProvider();
  return cached;
}

/** True when a real provider (Fonnte) is wired (token present + not forced to stub). */
export function isProviderConfigured(): boolean {
  return getWhatsAppProvider().name === 'fonnte';
}

/** Reset the memoized provider (tests / hot config reload). */
export function resetWhatsAppProvider(): void {
  cached = undefined;
}
