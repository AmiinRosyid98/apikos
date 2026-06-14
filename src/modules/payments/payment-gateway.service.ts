import { Prisma, type PaymentGatewayMethod, type PaymentGatewayStatus } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, iso } from '../../utils/serialize';
import { allowedMethodsForPlan } from '../../services/plan.service';
import {
  resolveTemplateBody,
  renderForContext,
  sendViaProvider,
  assertQuota,
} from '../whatsapp/whatsapp.service';
import { getPaymentProvider } from './providers/factory';
import { notify } from '../../services/notification.service';
import type { ListTxnQuery, ReconciliationQuery } from './payments.validators';

/** Format an amount as `Rp1.234.567` (id-ID). */
function rupiah(n: number): string {
  return `Rp${Math.round(n).toLocaleString('id-ID')}`;
}

type TxnRow = Prisma.PaymentGatewayTxnGetPayload<object>;

// PaymentMethod (the ledger enum) ← PaymentGatewayMethod (the gateway enum). The Payment.method
// ledger column is the coarse {cash,transfer,qris,va,ewallet,other}; map the fine gateway method.
function ledgerMethodFor(method: PaymentGatewayMethod): 'qris' | 'va' | 'ewallet' {
  if (method === 'qris') return 'qris';
  if (method.startsWith('va_')) return 'va';
  return 'ewallet';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function serializeTxn(t: TxnRow) {
  return {
    id: t.id,
    invoiceId: t.invoiceId,
    paymentId: t.paymentId,
    provider: t.provider,
    method: t.method,
    providerRef: t.providerRef,
    amount: dec(t.amount),
    status: t.status,
    instructions: t.instructions,
    paidAt: iso(t.paidAt),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Plan-based method availability (PRD §12.2). Single source of truth for the UI + the charge guard.
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function getAllowedMethods(tenantId: string): Promise<{
  plan: string;
  methods: PaymentGatewayMethod[];
  provider: 'stub' | 'midtrans';
  providerConfigured: boolean;
}> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionPlan: true },
  });
  if (!tenant) throw Errors.notFound('Tenant not found');
  const provider = getPaymentProvider();
  return {
    plan: tenant.subscriptionPlan,
    methods: allowedMethodsForPlan(tenant.subscriptionPlan),
    provider: provider.name,
    providerConfigured: provider.name === 'midtrans',
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Create charge (PRD §6.8 — POST /invoices/:id/charge). Validates the method is allowed for the
// tenant's plan, then asks the provider to create a `pending` txn with rendered instructions.
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function createCharge(
  tenantId: string,
  invoiceId: string,
  method: PaymentGatewayMethod,
) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    include: { resident: true },
  });
  if (!invoice) throw Errors.notFound('Invoice not found');
  if (invoice.status === 'paid') throw Errors.conflict('Invoice is already paid');
  if (invoice.status === 'cancelled') throw Errors.conflict('Invoice is cancelled');

  // Plan-based method availability (Basic = qris, Pro = qris+va, Premium = all).
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionPlan: true },
  });
  if (!tenant) throw Errors.notFound('Tenant not found');
  const allowed = allowedMethodsForPlan(tenant.subscriptionPlan);
  if (!allowed.includes(method)) {
    throw Errors.planLimit(
      `Payment method '${method}' is not available on the ${tenant.subscriptionPlan} plan. ` +
        `Allowed methods: ${allowed.join(', ')}. Upgrade your plan for more methods.`,
    );
  }

  // Charge the remaining balance (total − already paid). Falls back to total when paidAmount is 0.
  const amount = round2(Number(invoice.totalAmount) - Number(invoice.paidAmount));
  if (amount <= 0) throw Errors.conflict('Invoice has no outstanding balance to charge');

  const provider = getPaymentProvider();
  const charge = await provider.createCharge({
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      residentName: invoice.resident?.fullName ?? null,
    },
    method,
    amount,
  });

  const txn = await prisma.paymentGatewayTxn.create({
    data: {
      tenantId,
      invoiceId: invoice.id,
      provider: provider.name,
      method,
      providerRef: charge.providerRef,
      amount,
      status: 'pending',
      instructions: charge.instructions as unknown as Prisma.InputJsonValue,
    },
  });

  return serializeTxn(txn);
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Webhook handling (PRD §6.8 — POST /webhooks/payment, PUBLIC). Verified via provider.verifyWebhook.
// On `paid` (idempotently): record a Payment on the invoice (recompute status), link txn.paymentId,
// flip txn → paid, fire the payment_received WA stub. On failed/expired: update the txn only.
//
// IDEMPOTENCY: guard on providerRef + current txn status. A txn that is already `paid` (or any
// terminal state) is left untouched — a replayed webhook records NO second Payment.
// ──────────────────────────────────────────────────────────────────────────────────────────
export interface WebhookOutcome {
  handled: boolean;
  providerRef?: string;
  status?: PaymentGatewayStatus;
  idempotent?: boolean; // true when the webhook was a no-op replay
  paymentId?: string | null;
  reason?: string;
}

/**
 * Process a verified webhook result. `tenantIdHint` is unused for lookup (providerRef is globally
 * unique) but kept for symmetry; the txn's own tenantId scopes the rest via runWithTenant upstream.
 */
export async function applyVerifiedWebhook(verified: {
  providerRef: string;
  status: 'paid' | 'failed' | 'expired';
  amount: number;
  paidAt?: string;
}): Promise<WebhookOutcome> {
  // providerRef is globally unique → look it up with a raw, un-scoped guard-bypassing query is NOT
  // needed here because the public webhook route runs OUTSIDE tenantContext; the caller wraps this
  // in runWithTenant after resolving the txn's tenant. We accept a pre-resolved txn via findFirst.
  const txn = await prisma.paymentGatewayTxn.findFirst({ where: { providerRef: verified.providerRef } });
  if (!txn) {
    return { handled: false, providerRef: verified.providerRef, reason: 'unknown providerRef' };
  }

  // Idempotency: only a `pending` txn can transition. Anything else is a replay → no-op.
  if (txn.status !== 'pending') {
    return {
      handled: false,
      idempotent: true,
      providerRef: txn.providerRef,
      status: txn.status,
      paymentId: txn.paymentId,
      reason: `txn already ${txn.status}`,
    };
  }

  if (verified.status !== 'paid') {
    const updated = await prisma.paymentGatewayTxn.update({
      where: { id: txn.id },
      data: { status: verified.status },
    });
    return {
      handled: true,
      providerRef: txn.providerRef,
      status: updated.status,
      paymentId: null,
    };
  }

  // ── PAID: record a Payment + recompute invoice status + link the txn, in one transaction. ──
  const invoice = await prisma.invoice.findFirst({ where: { id: txn.invoiceId } });
  if (!invoice) {
    return { handled: false, providerRef: txn.providerRef, reason: 'invoice not found' };
  }

  // The amount to record = the txn amount (what the provider settled), clamped to the remaining
  // balance so a stale/over webhook can never overpay the ledger.
  const balance = round2(Number(invoice.totalAmount) - Number(invoice.paidAmount));
  const payAmount = round2(Math.min(Number(txn.amount), balance));

  const paymentId = await prisma.$transaction(async (tx) => {
    // Re-read the txn inside the tx and re-check it is still pending (concurrent-webhook guard).
    const fresh = await tx.paymentGatewayTxn.findUnique({ where: { id: txn.id } });
    if (!fresh || fresh.status !== 'pending') return fresh?.paymentId ?? null;

    let newPaymentId: string | null = null;
    if (payAmount > 0) {
      const payment = await tx.payment.create({
        data: {
          tenantId: txn.tenantId,
          invoiceId: txn.invoiceId,
          amount: payAmount,
          method: ledgerMethodFor(txn.method),
          paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
          reference: `gateway:${txn.provider}:${txn.providerRef}`,
          recordedBy: txn.tenantId, // system-recorded (no human user); tenantId as a non-null marker
        },
      });
      newPaymentId = payment.id;

      const newPaid = round2(Number(invoice.paidAmount) + payAmount);
      const status =
        newPaid >= Number(invoice.totalAmount) && Number(invoice.totalAmount) > 0
          ? 'paid'
          : 'partial';
      await tx.invoice.update({
        where: { id: txn.invoiceId },
        data: { paidAmount: newPaid, status },
      });
    }

    await tx.paymentGatewayTxn.update({
      where: { id: txn.id },
      data: {
        status: 'paid',
        paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
        paymentId: newPaymentId,
      },
    });
    return newPaymentId;
  });

  // Best-effort WhatsApp payment_received notification (stub send). Never breaks the webhook.
  await notifyPaymentReceived(txn.tenantId, txn.invoiceId).catch(() => {});

  // Best-effort IN-APP payment_received notification (PRD §6.18). notify() is failure-isolated.
  if (paymentId) {
    await emitPaymentReceivedNotification(txn.tenantId, txn.invoiceId, payAmount);
  }

  return {
    handled: true,
    providerRef: txn.providerRef,
    status: 'paid',
    paymentId,
  };
}

/**
 * Resolve a txn's tenantId from a (verified) providerRef — used by the PUBLIC webhook route, which
 * runs OUTSIDE tenantContext, to know which tenant to scope into before applying the webhook.
 * Uses a guard-bypassing lookup is unnecessary (the public route has no tenant in context, so the
 * extension does not filter); a plain findFirst on the unique providerRef resolves it.
 */
export async function resolveTxnTenant(providerRef: string): Promise<string | null> {
  const txn = await prisma.paymentGatewayTxn.findFirst({
    where: { providerRef },
    select: { tenantId: true },
  });
  return txn?.tenantId ?? null;
}

/**
 * Emit an IN-APP `payment_received` notification (PRD §6.18) for a settled invoice → owner/manager/
 * finance (the default role mapping). Best-effort — notify() is failure-isolated and never throws.
 */
export async function emitPaymentReceivedNotification(
  tenantId: string,
  invoiceId: string,
  amount: number,
): Promise<void> {
  const invoice = await prisma.invoice
    .findFirst({ where: { id: invoiceId }, select: { invoiceNumber: true } })
    .catch(() => null);
  const invNo = invoice?.invoiceNumber ?? invoiceId;
  await notify({
    tenantId,
    type: 'payment_received',
    title: 'Pembayaran diterima',
    body: `Pembayaran ${invNo} sebesar ${rupiah(amount)} telah diterima.`,
    link: `/invoices/${invoiceId}`,
    entityType: 'invoice',
    entityId: invoiceId,
  });
}

/** Send the payment_received WhatsApp stub for an invoice (best-effort; quota-aware). */
async function notifyPaymentReceived(tenantId: string, invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    include: { resident: true, property: true, room: true },
  });
  if (!invoice || !invoice.resident?.phone) return;
  try {
    await assertQuota(tenantId, 1);
  } catch {
    return; // quota exhausted → skip the notification (does not fail the payment)
  }
  const body = renderForContext(await resolveTemplateBody('payment_received', invoice.propertyId), {
    residentName: invoice.resident.fullName,
    roomNumber: invoice.room?.roomNumber ?? null,
    invoiceAmount: Number(invoice.totalAmount),
    dueDate: invoice.dueDate,
    propertyName: invoice.property.name,
  });
  await sendViaProvider({
    tenantId,
    toPhone: invoice.resident.phone,
    toName: invoice.resident.fullName,
    body,
    propertyId: invoice.propertyId,
    residentId: invoice.residentId,
    invoiceId: invoice.id,
    templateType: 'payment_received',
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Simulate (PRD §6.8 — POST /payment-txns/:id/simulate, STUB-ONLY). Drives the same webhook flow
// for a pending txn so the demo works without real money. Rejected when a real provider is active.
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function simulateTxn(
  txnId: string,
  outcome: 'paid' | 'failed' | 'expired',
): Promise<WebhookOutcome> {
  const provider = getPaymentProvider();
  if (provider.name !== 'stub') {
    throw Errors.validation(
      'Simulate is only available in stub mode. With a real provider, trigger the actual webhook.',
    );
  }
  const txn = await prisma.paymentGatewayTxn.findFirst({ where: { id: txnId } });
  if (!txn) throw Errors.notFound('Transaction not found');
  if (txn.status !== 'pending') {
    throw Errors.conflict(`Cannot simulate a txn that is already ${txn.status}`);
  }

  // Build a stub webhook payload and run it through the SAME verify + apply path.
  const verified = await provider.verifyWebhook(
    { providerRef: txn.providerRef, status: outcome, amount: Number(txn.amount) },
    {},
  );
  if (!verified) throw Errors.internal('Stub webhook verification failed');
  return applyVerifiedWebhook(verified);
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// List / detail
// ──────────────────────────────────────────────────────────────────────────────────────────
/** The invoice's txns (GET /invoices/:id/charges). */
export async function listInvoiceCharges(invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId }, select: { id: true } });
  if (!invoice) throw Errors.notFound('Invoice not found');
  const rows = await prisma.paymentGatewayTxn.findMany({
    where: { invoiceId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializeTxn);
}

/** All txns, filtered + paginated (GET /payment-txns). */
export async function listTxns(q: ListTxnQuery, scope: string[] | undefined) {
  const where: Prisma.PaymentGatewayTxnWhereInput = {};
  if (q.status) where.status = q.status;
  if (q.method) where.method = q.method;
  if (q.date_from || q.date_to) {
    where.createdAt = {};
    if (q.date_from) where.createdAt.gte = new Date(`${q.date_from}T00:00:00.000Z`);
    if (q.date_to) where.createdAt.lte = new Date(`${q.date_to}T23:59:59.999Z`);
  }
  // Property scope: a restricted user only sees txns for invoices in their allowed properties.
  if (scope !== undefined) {
    where.invoice = { propertyId: { in: scope } };
  }

  const [rows, total] = await Promise.all([
    prisma.paymentGatewayTxn.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.paymentGatewayTxn.count({ where }),
  ]);
  return { rows: rows.map(serializeTxn), total };
}

/** The invoice's property (for the property-scope guard in the controller). */
export async function getTxnInvoicePropertyId(invoiceId: string): Promise<string> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    select: { propertyId: true },
  });
  if (!inv) throw Errors.notFound('Invoice not found');
  return inv.propertyId;
}

/** The txn's property (for the property-scope guard on simulate). */
export async function getTxnPropertyId(txnId: string): Promise<string> {
  const txn = await prisma.paymentGatewayTxn.findFirst({
    where: { id: txnId },
    include: { invoice: { select: { propertyId: true } } },
  });
  if (!txn) throw Errors.notFound('Transaction not found');
  return txn.invoice.propertyId;
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Reconciliation (PRD §6.8 — GET /payments/reconciliation). Matched vs unmatched: gateway `paid`
// txns vs recorded payments vs invoices for the period. Flags mismatches.
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function reconcile(q: ReconciliationQuery, scope: string[] | undefined) {
  const now = new Date();
  const month = q.month ?? now.getMonth() + 1;
  const year = q.year ?? now.getFullYear();
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  // Property filter: explicit property_id (honoring scope) or the scope allowlist.
  let propertyFilter: Prisma.InvoiceWhereInput = {};
  if (q.property_id) {
    if (scope !== undefined && !scope.includes(q.property_id)) {
      propertyFilter = { propertyId: '__none__' }; // out-of-scope → no rows (no existence leak)
    } else {
      propertyFilter = { propertyId: q.property_id };
    }
  } else if (scope !== undefined) {
    propertyFilter = { propertyId: { in: scope } };
  }

  // Gateway `paid` txns created in the window (joined to in-scope invoices).
  const txnWhere: Prisma.PaymentGatewayTxnWhereInput = {
    status: 'paid',
    createdAt: { gte: start, lt: end },
    ...(Object.keys(propertyFilter).length ? { invoice: propertyFilter } : {}),
  };
  const paidTxns = await prisma.paymentGatewayTxn.findMany({
    where: txnWhere,
    select: { id: true, amount: true, paymentId: true, providerRef: true, invoiceId: true },
  });

  // Recorded gateway-originated payments in the window (reference starts 'gateway:').
  const gatewayPayments = await prisma.payment.findMany({
    where: {
      reference: { startsWith: 'gateway:' },
      paidAt: { gte: start, lt: end },
      ...(Object.keys(propertyFilter).length ? { invoice: propertyFilter } : {}),
    },
    select: { id: true, amount: true, invoiceId: true },
  });

  // Invoices billed for the period (for the invoiced-vs-collected picture).
  const invoices = await prisma.invoice.findMany({
    where: {
      periodMonth: month,
      periodYear: year,
      status: { not: 'cancelled' },
      ...propertyFilter,
    },
    select: { id: true, totalAmount: true, paidAmount: true, status: true },
  });

  const gatewayPaidTotal = round2(paidTxns.reduce((s, t) => s + Number(t.amount), 0));
  const recordedPaymentTotal = round2(gatewayPayments.reduce((s, p) => s + Number(p.amount), 0));
  const invoicedTotal = round2(invoices.reduce((s, i) => s + Number(i.totalAmount), 0));
  const collectedTotal = round2(invoices.reduce((s, i) => s + Number(i.paidAmount), 0));

  // Matched = a paid txn that has a linked paymentId; unmatched = paid txn without a Payment row.
  const matched = paidTxns.filter((t) => t.paymentId);
  const unmatchedTxns = paidTxns.filter((t) => !t.paymentId);

  // Flags: paid-txn total should equal recorded gateway-payment total (each paid txn → one Payment).
  const flags: { code: string; message: string }[] = [];
  if (unmatchedTxns.length) {
    flags.push({
      code: 'TXN_WITHOUT_PAYMENT',
      message: `${unmatchedTxns.length} paid gateway txn(s) have no linked Payment row.`,
    });
  }
  if (Math.abs(gatewayPaidTotal - recordedPaymentTotal) > 0.01) {
    flags.push({
      code: 'GATEWAY_AMOUNT_MISMATCH',
      message: `Gateway paid total (${gatewayPaidTotal}) != recorded gateway-payment total (${recordedPaymentTotal}).`,
    });
  }

  return {
    period: { month, year },
    gateway: {
      paidTxnCount: paidTxns.length,
      paidTxnTotal: gatewayPaidTotal,
      matchedCount: matched.length,
      unmatchedCount: unmatchedTxns.length,
      unmatchedRefs: unmatchedTxns.map((t) => t.providerRef),
    },
    payments: {
      gatewayPaymentCount: gatewayPayments.length,
      gatewayPaymentTotal: recordedPaymentTotal,
    },
    invoices: {
      count: invoices.length,
      invoicedTotal,
      collectedTotal,
      outstandingTotal: round2(invoicedTotal - collectedTotal),
    },
    reconciled: flags.length === 0,
    flags,
  };
}
