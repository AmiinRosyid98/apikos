import type { WhatsAppProvider, WhatsAppSendResult } from './provider';

/**
 * FonnteProvider — the REAL WhatsApp sender (PRD §6.9), used only when FONNTE_TOKEN is set.
 *
 * Fonnte API shape (https://docs.fonnte.com/):
 *   POST https://api.fonnte.com/send
 *   Headers: { Authorization: <FONNTE_TOKEN> }
 *   Body (form-encoded): { target: <phone>, message: <text> }
 *   Success JSON: { status: true, id: ["<messageId>"], ... } | failure: { status:false, reason }
 *
 * This is a working skeleton. It is intentionally lightly tested because we have no token here —
 * the POINT of the seam is that plugging in a token is a config-only swap (the factory selects
 * this class). When a token is available, verify the response parsing against the live API.
 *
 * `send` NEVER throws — network/parse failures are caught and returned as `status:'failed'` so the
 * send pipeline records a `failed` wa_messages row instead of crashing the request/cron.
 */
const FONNTE_ENDPOINT = 'https://api.fonnte.com/send';

export class FonnteProvider implements WhatsAppProvider {
  readonly name = 'fonnte' as const;

  constructor(private readonly token: string) {}

  /** Normalize an Indonesian phone to Fonnte's expected target (leading 62, no +/spaces). */
  static normalizePhone(phone: string): string {
    const digits = phone.replace(/[^\d]/g, '');
    if (digits.startsWith('0')) return `62${digits.slice(1)}`;
    if (digits.startsWith('62')) return digits;
    return digits;
  }

  async send(toPhone: string, body: string): Promise<WhatsAppSendResult> {
    const target = FonnteProvider.normalizePhone(toPhone);
    try {
      const form = new URLSearchParams();
      form.set('target', target);
      form.set('message', body);

      const res = await fetch(FONNTE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });

      const json = (await res.json().catch(() => ({}))) as {
        status?: boolean;
        id?: string[] | string;
        reason?: string;
        detail?: string;
      };

      if (!res.ok || json.status === false) {
        return {
          status: 'failed',
          error: json.reason || json.detail || `Fonnte HTTP ${res.status}`,
        };
      }

      const providerMessageId = Array.isArray(json.id) ? json.id[0] : json.id;
      return { status: 'sent', providerMessageId };
    } catch (e) {
      return { status: 'failed', error: (e as Error).message };
    }
  }
}
