/**
 * WhatsApp provider seam (PRD §6.9). The CRITICAL abstraction: every send path (invoice send,
 * broadcast, reminder cron) goes through whatsapp.service → a `WhatsAppProvider`. Swapping the
 * real provider in (Fonnte) is a CONFIG change only — no caller changes.
 *
 *   - StubProvider  (DEFAULT, no FONNTE_TOKEN): never touches the network; logs structured and
 *     returns status 'sent', but the service records the wa_messages row with status 'stub' so
 *     the UI can show "mode demo".
 *   - FonnteProvider (skeleton, used only when FONNTE_TOKEN is set): real POST to the Fonnte API.
 *
 * The factory `getWhatsAppProvider()` picks Fonnte iff FONNTE_TOKEN is set, else Stub.
 */

export interface WhatsAppSendResult {
  /** Provider's message id (when the provider returns one). */
  providerMessageId?: string;
  /** 'sent' = dispatched by the provider; 'failed' = provider rejected/errored. */
  status: 'sent' | 'failed';
  /** Failure detail (when status === 'failed'). */
  error?: string;
}

export interface WhatsAppProvider {
  /** Stable provider name for logs + the status endpoint ('stub' | 'fonnte'). */
  readonly name: 'stub' | 'fonnte';
  /** Send a rendered message body to a phone number. Never throws — returns a result object. */
  send(toPhone: string, body: string): Promise<WhatsAppSendResult>;
}
