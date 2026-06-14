import type { WhatsAppProvider, WhatsAppSendResult } from './provider';

/**
 * StubProvider — DEFAULT when no FONNTE_TOKEN is configured (PRD §6.9, MVP stub mode).
 *
 * Does NOT call any network. It logs a structured line and returns `status:'sent'` so the send
 * pipeline behaves end-to-end; the caller (whatsapp.service) records the wa_messages row with
 * status `stub` (NOT `sent`) so the frontend can clearly show "mode demo — pesan tidak dikirim".
 *
 * Returning a fake providerMessageId keeps the result shape identical to the real provider.
 */
export class StubProvider implements WhatsAppProvider {
  readonly name = 'stub' as const;

  async send(toPhone: string, body: string): Promise<WhatsAppSendResult> {
    const providerMessageId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        provider: 'stub',
        event: 'wa.stub.send',
        toPhone,
        bodyPreview: body.slice(0, 80),
        bodyLength: body.length,
        providerMessageId,
        note: 'STUB MODE — message NOT actually sent',
      }),
    );
    return { status: 'sent', providerMessageId };
  }
}
