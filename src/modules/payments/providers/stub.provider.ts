import { randomUUID } from 'crypto';
import type { PaymentGatewayMethod } from '@prisma/client';
import type {
  PaymentProvider,
  CreateChargeParams,
  CreateChargeResult,
  VerifyWebhookResult,
  PaymentInstructions,
  InstructionType,
} from './provider';

/**
 * StubProvider — DEFAULT when no MIDTRANS_SERVER_KEY is configured (PRD §6.8, MVP stub mode).
 *
 * Does NOT call any network and moves NO real money. `createCharge` fabricates a real-looking QR
 * string / VA number / e-wallet deeplink so the frontend can render genuine payment instructions.
 * `verifyWebhook` accepts the simulated callback (sent by the /payment-txns/:id/simulate endpoint
 * or any client) WITHOUT a signature — the body itself carries providerRef + status.
 *
 * Going live = setting MIDTRANS_SERVER_KEY; the factory then returns the Midtrans provider and this
 * class is no longer used. No caller changes.
 */

/** Map a method to the instruction type the UI renders. */
export function instructionTypeFor(method: PaymentGatewayMethod): InstructionType {
  if (method === 'qris') return 'qris';
  if (method.startsWith('va_')) return 'va';
  return 'ewallet';
}

/** Bank code from a va_* method (e.g. 'va_bca' → 'bca'). */
function bankFor(method: PaymentGatewayMethod): string | undefined {
  return method.startsWith('va_') ? method.slice(3) : undefined;
}

const VA_PREFIX: Record<string, string> = {
  bca: '39010',
  bni: '98510',
  bri: '88810',
  mandiri: '89010',
  permata: '85510',
};

export class StubProvider implements PaymentProvider {
  readonly name = 'stub' as const;

  /** Default instruction validity window (stub): 24h. */
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    const { method, amount, invoice } = params;
    // A unique, recognizable stub reference. Real-looking but obviously a stub.
    const providerRef = `STUB-${invoice.invoiceNumber}-${randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + StubProvider.TTL_MS).toISOString();
    const type = instructionTypeFor(method);

    let instructions: PaymentInstructions;
    if (type === 'qris') {
      // A QRIS-like payload string (the UI renders a QR image from it). Fake but plausible.
      const payload = `00020101021226${String(amount).padStart(10, '0')}5204000053033605802ID5910KOSMANAGER6007JAKARTA6304${randomUUID().slice(0, 4).toUpperCase()}`;
      instructions = { type, qrString: payload, expiresAt };
    } else if (type === 'va') {
      const bank = bankFor(method)!;
      const prefix = VA_PREFIX[bank] ?? '90010';
      const vaNumber = `${prefix}${Math.floor(1e10 + Math.random() * 8e10)}`.slice(0, 16);
      instructions = { type, vaNumber, bank, expiresAt };
    } else {
      // E-wallet deeplink (gopay/ovo/dana/shopeepay/linkaja).
      const deeplink = `https://stub.kosmanager.local/ewallet/${method}/${providerRef}`;
      instructions = { type, deeplink, expiresAt };
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        provider: 'stub',
        event: 'gateway.stub.charge',
        invoiceId: invoice.id,
        method,
        amount,
        providerRef,
        note: 'STUB MODE — no real money; instructions are fabricated',
      }),
    );

    return { providerRef, status: 'pending', instructions };
  }

  /**
   * Accept a simulated webhook WITHOUT signature verification. The body must carry providerRef +
   * status (+ optional amount/paidAt). Returns null only when the body is unparseable (never throws).
   */
  async verifyWebhook(
    payload: unknown,
    _headers: Record<string, string | undefined>,
  ): Promise<VerifyWebhookResult | null> {
    try {
      const b = (payload ?? {}) as Record<string, unknown>;
      const providerRef = typeof b.providerRef === 'string' ? b.providerRef : (b.order_id as string);
      if (!providerRef) return null;

      const raw = (b.status as string) ?? (b.transaction_status as string) ?? 'paid';
      const status: VerifyWebhookResult['status'] =
        raw === 'failed' || raw === 'deny' || raw === 'cancel'
          ? 'failed'
          : raw === 'expired' || raw === 'expire'
            ? 'expired'
            : 'paid';

      const amount =
        typeof b.amount === 'number'
          ? b.amount
          : typeof b.gross_amount === 'string'
            ? Number(b.gross_amount)
            : 0;
      const paidAt =
        status === 'paid'
          ? typeof b.paidAt === 'string'
            ? b.paidAt
            : new Date().toISOString()
          : undefined;

      return { providerRef, status, amount, paidAt };
    } catch {
      return null;
    }
  }
}
