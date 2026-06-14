/**
 * Payment-gateway provider seam (PRD §6.8). The CRITICAL abstraction: every charge/verify path
 * (create charge, webhook, simulate) goes through payment-gateway.service → a `PaymentProvider`.
 * Swapping the real provider in (Midtrans) is a CONFIG change only — set MIDTRANS_SERVER_KEY and
 * the factory returns the Midtrans provider; no caller changes.
 *
 *   - StubProvider     (DEFAULT, no MIDTRANS_SERVER_KEY): never touches the network; returns a
 *     FAKE QR string / VA number / e-wallet deeplink so the UI renders real-looking instructions.
 *     `verifyWebhook` accepts the simulated callback without a signature.
 *   - MidtransProvider (skeleton, used only when MIDTRANS_SERVER_KEY is set): real Snap/Core API
 *     shapes + signature verification, structured but never throws.
 *
 * The factory `getPaymentProvider()` picks Midtrans iff MIDTRANS_SERVER_KEY is set, else Stub.
 */
import type { PaymentGatewayMethod } from '@prisma/client';

/** The instruction "type" the UI uses to decide how to render the payment screen. */
export type InstructionType = 'qris' | 'va' | 'ewallet';

/** Rendered payment instructions returned by createCharge (persisted on the txn as JSON). */
export interface PaymentInstructions {
  type: InstructionType;
  /** QRIS payload string (qris methods) — the UI renders a QR image from this. */
  qrString?: string;
  /** Virtual-account number (va_* methods). */
  vaNumber?: string;
  /** Bank code for VA (e.g. 'bca', 'bni'). */
  bank?: string;
  /** E-wallet deeplink / redirect URL (gopay/ovo/dana/...). */
  deeplink?: string;
  /** ISO expiry — when the instruction lapses (the txn auto-expires after this). */
  expiresAt?: string;
}

export interface CreateChargeParams {
  /** Provider-agnostic invoice snapshot needed to build a charge. */
  invoice: { id: string; invoiceNumber: string; residentName?: string | null };
  method: PaymentGatewayMethod;
  amount: number;
}

export interface CreateChargeResult {
  /** The provider's transaction reference (Midtrans order_id / our stub ref). Unique. */
  providerRef: string;
  /** A freshly-created charge is always `pending`. */
  status: 'pending';
  instructions: PaymentInstructions;
}

export interface VerifyWebhookResult {
  /** The providerRef the webhook refers to (matches a txn row). */
  providerRef: string;
  /** The settled status the webhook reports. */
  status: 'paid' | 'failed' | 'expired';
  /** Amount the provider settled (used as a sanity check against the txn amount). */
  amount: number;
  /** ISO settlement time (when status === 'paid'). */
  paidAt?: string;
}

export interface PaymentProvider {
  /** Stable provider name for logs + the status/txn rows ('stub' | 'midtrans'). */
  readonly name: 'stub' | 'midtrans';
  /**
   * Create a charge with the provider. Returns a providerRef + rendered instructions. The Stub
   * provider fabricates real-looking instructions without any network call.
   */
  createCharge(params: CreateChargeParams): Promise<CreateChargeResult>;
  /**
   * Verify + parse an incoming webhook payload into a normalized result. NEVER throws — an invalid
   * signature or unparseable body returns null (the caller responds 200 but does nothing). The Stub
   * provider accepts the simulated callback without a signature.
   */
  verifyWebhook(
    payload: unknown,
    headers: Record<string, string | undefined>,
  ): Promise<VerifyWebhookResult | null>;
}
