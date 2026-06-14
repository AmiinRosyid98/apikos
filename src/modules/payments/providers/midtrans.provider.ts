import { createHash } from 'crypto';
import type { PaymentGatewayMethod } from '@prisma/client';
import type {
  PaymentProvider,
  CreateChargeParams,
  CreateChargeResult,
  VerifyWebhookResult,
  PaymentInstructions,
} from './provider';
import { instructionTypeFor } from './stub.provider';

/**
 * MidtransProvider — the REAL payment gateway (PRD §6.8), used only when MIDTRANS_SERVER_KEY is set.
 *
 * Midtrans Core API shape (https://docs.midtrans.com/reference/charge):
 *   POST {baseUrl}/v2/charge
 *   Headers: { Authorization: 'Basic base64(SERVER_KEY + ":")', 'Content-Type': 'application/json' }
 *   Body: { payment_type, transaction_details:{ order_id, gross_amount }, <type-specific fields> }
 *   Response (qris): { transaction_status:'pending', actions:[{name:'generate-qr-code', url}], qr_string }
 *   Response (bank_transfer): { va_numbers:[{ bank, va_number }] }
 *   Response (gopay/...): { actions:[{name:'deeplink-redirect', url}] }
 *
 * Webhook (HTTP notification) signature (https://docs.midtrans.com/reference/notification):
 *   signature_key = sha512(order_id + status_code + gross_amount + SERVER_KEY)
 *
 * This is a WORKING SKELETON. It is intentionally lightly exercised because we have no key here —
 * the POINT of the seam is that plugging in a key is a config-only swap (the factory selects this
 * class). When a key is available, verify the request/response shapes against the live API.
 *
 * Neither method THROWS: createCharge maps a network/parse failure to a thrown AppError ONLY via the
 * caller (here it returns a structured error by rejecting); verifyWebhook returns null on a bad
 * signature/body so the webhook endpoint can safely 200 without acting.
 */

const SANDBOX_BASE = 'https://api.sandbox.midtrans.com';
const PRODUCTION_BASE = 'https://api.midtrans.com';

/** Map our method enum → Midtrans payment_type + the type-specific charge fields. */
function midtransChargeFields(
  method: PaymentGatewayMethod,
  orderId: string,
  amount: number,
): Record<string, unknown> {
  const base = {
    transaction_details: { order_id: orderId, gross_amount: amount },
  };
  if (method === 'qris') {
    return { payment_type: 'qris', ...base, qris: { acquirer: 'gopay' } };
  }
  if (method.startsWith('va_')) {
    const bank = method.slice(3);
    // Permata uses a distinct payment_type; the other banks use bank_transfer.
    if (bank === 'permata') return { payment_type: 'permata', ...base };
    return { payment_type: 'bank_transfer', ...base, bank_transfer: { bank } };
  }
  // E-wallets.
  if (method === 'gopay') return { payment_type: 'gopay', ...base };
  if (method === 'shopeepay') return { payment_type: 'shopeepay', ...base };
  // ovo/dana/linkaja are typically routed via Snap; modeled as generic e-wallet payment_type here.
  return { payment_type: method, ...base };
}

interface MidtransChargeResponse {
  transaction_status?: string;
  order_id?: string;
  qr_string?: string;
  va_numbers?: { bank: string; va_number: string }[];
  permata_va_number?: string;
  actions?: { name: string; url: string }[];
  expiry_time?: string;
  status_message?: string;
  error_messages?: string[];
}

export class MidtransProvider implements PaymentProvider {
  readonly name = 'midtrans' as const;

  constructor(
    private readonly serverKey: string,
    private readonly isProduction: boolean,
  ) {}

  private get baseUrl(): string {
    return this.isProduction ? PRODUCTION_BASE : SANDBOX_BASE;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.serverKey}:`).toString('base64')}`;
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    const { method, amount, invoice } = params;
    // Use a unique order_id (Midtrans rejects reused ones). invoiceNumber + timestamp suffix.
    const orderId = `${invoice.invoiceNumber}-${Date.now()}`;
    const body = midtransChargeFields(method, orderId, amount);

    const res = await fetch(`${this.baseUrl}/v2/charge`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as MidtransChargeResponse;

    if (!res.ok) {
      const msg = json.error_messages?.join(', ') || json.status_message || `Midtrans HTTP ${res.status}`;
      throw new Error(`Midtrans charge failed: ${msg}`);
    }

    const type = instructionTypeFor(method);
    const expiresAt = json.expiry_time ? new Date(json.expiry_time).toISOString() : undefined;
    let instructions: PaymentInstructions;
    if (type === 'qris') {
      const qrAction = json.actions?.find((a) => a.name === 'generate-qr-code');
      instructions = { type, qrString: json.qr_string ?? qrAction?.url, expiresAt };
    } else if (type === 'va') {
      const bank = method.slice(3);
      const vaNumber =
        json.va_numbers?.[0]?.va_number ?? json.permata_va_number ?? undefined;
      instructions = { type, vaNumber, bank, expiresAt };
    } else {
      const deeplink = json.actions?.find((a) => a.name === 'deeplink-redirect')?.url;
      instructions = { type, deeplink, expiresAt };
    }

    return { providerRef: orderId, status: 'pending', instructions };
  }

  /**
   * Verify the Midtrans notification signature and normalize it. Returns null (never throws) on a
   * bad signature or unparseable body so the webhook endpoint can respond 200 without acting.
   *
   * signature_key = sha512(order_id + status_code + gross_amount + serverKey)
   * transaction_status → our status: settlement/capture → paid; expire → expired; deny/cancel/failure → failed.
   */
  async verifyWebhook(
    payload: unknown,
    _headers: Record<string, string | undefined>,
  ): Promise<VerifyWebhookResult | null> {
    try {
      const b = (payload ?? {}) as Record<string, unknown>;
      const orderId = b.order_id as string | undefined;
      const statusCode = b.status_code as string | undefined;
      const grossAmount = b.gross_amount as string | undefined;
      const sigKey = b.signature_key as string | undefined;
      const txnStatus = b.transaction_status as string | undefined;
      if (!orderId || !statusCode || !grossAmount || !sigKey || !txnStatus) return null;

      const expected = createHash('sha512')
        .update(`${orderId}${statusCode}${grossAmount}${this.serverKey}`)
        .digest('hex');
      if (expected !== sigKey) return null; // invalid signature → ignore

      let status: VerifyWebhookResult['status'];
      if (txnStatus === 'settlement' || txnStatus === 'capture') status = 'paid';
      else if (txnStatus === 'expire') status = 'expired';
      else if (txnStatus === 'deny' || txnStatus === 'cancel' || txnStatus === 'failure')
        status = 'failed';
      else return null; // pending / other → no action

      return {
        providerRef: orderId,
        status,
        amount: Number(grossAmount),
        paidAt: status === 'paid' ? ((b.settlement_time as string) ?? new Date().toISOString()) : undefined,
      };
    } catch {
      return null;
    }
  }
}
