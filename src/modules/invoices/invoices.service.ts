import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, dateOnly, iso } from '../../utils/serialize';
import { presignDownloadIfExists } from '../files/files.service';
import type {
  GenerateInvoiceInput,
  CreateInvoiceInput,
  UpdateInvoiceInput,
  RecordPaymentInput,
  ListInvoiceQuery,
} from './invoices.validators';

// Transaction client type from the *extended* prisma client (so $transaction(tx) matches).
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type InvoiceRow = Prisma.InvoiceGetPayload<object>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Per-tenant invoice numbering (A8/fix h). INV-{YEAR}-{6-digit seq}. Runs inside the same
 * transaction as the invoice insert; the tenant_counters row is updated atomically so seqs
 * never collide or gap within a tenant.
 */
async function nextInvoiceNumber(tx: TxClient, tenantId: string, year: number): Promise<string> {
  const counter = await tx.tenantCounter.findUnique({ where: { tenantId } });
  let seq: number;
  if (!counter) {
    await tx.tenantCounter.create({
      data: { tenantId, invoiceSeqYear: year, invoiceSeq: 1 },
    });
    seq = 1;
  } else if (counter.invoiceSeqYear !== year) {
    await tx.tenantCounter.update({
      where: { tenantId },
      data: { invoiceSeqYear: year, invoiceSeq: 1 },
    });
    seq = 1;
  } else {
    const updated = await tx.tenantCounter.update({
      where: { tenantId },
      data: { invoiceSeq: { increment: 1 } },
    });
    seq = updated.invoiceSeq;
  }
  return `INV-${year}-${String(seq).padStart(6, '0')}`;
}

/** Pro-rata rent for a mid-month check-in within the invoice's period. */
export function computeProRata(
  monthlyRent: number,
  periodYear: number,
  periodMonth: number,
  checkInDate: Date,
): { amount: number; prorated: boolean; daysCharged: number; daysInMonth: number } {
  const daysInMonth = new Date(periodYear, periodMonth, 0).getDate();
  const ci = new Date(checkInDate);
  const sameMonth = ci.getFullYear() === periodYear && ci.getMonth() + 1 === periodMonth;
  if (!sameMonth || ci.getDate() <= 1) {
    return { amount: round2(monthlyRent), prorated: false, daysCharged: daysInMonth, daysInMonth };
  }
  const daysCharged = daysInMonth - ci.getDate() + 1;
  const amount = round2((monthlyRent / daysInMonth) * daysCharged);
  return { amount, prorated: true, daysCharged, daysInMonth };
}

function serializeInvoice(inv: InvoiceRow) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    propertyId: inv.propertyId,
    roomId: inv.roomId,
    residentId: inv.residentId,
    periodMonth: inv.periodMonth,
    periodYear: inv.periodYear,
    dueDate: dateOnly(inv.dueDate),
    subtotal: dec(inv.subtotal),
    lateFee: dec(inv.lateFee),
    totalAmount: dec(inv.totalAmount),
    paidAmount: dec(inv.paidAmount),
    status: inv.status,
    notes: inv.notes,
    createdAt: iso(inv.createdAt),
  };
}

function dueDateFor(year: number, month: number, billingDay: number): Date {
  const day = Math.min(billingDay || 1, new Date(year, month, 0).getDate());
  return new Date(Date.UTC(year, month - 1, day));
}

export async function listInvoices(q: ListInvoiceQuery, scope: string[] | undefined) {
  const where: Prisma.InvoiceWhereInput = {};
  if (q.status) where.status = q.status;
  if (q.resident_id) where.residentId = q.resident_id;
  if (q.period_month) where.periodMonth = q.period_month;
  if (q.period_year) where.periodYear = q.period_year;
  if (q.overdue) {
    where.status = { in: ['unpaid', 'partial', 'overdue'] };
    where.dueDate = { lt: new Date() };
  }
  if (q.property_id) where.propertyId = q.property_id;
  if (scope !== undefined) {
    where.propertyId = q.property_id && scope.includes(q.property_id) ? q.property_id : { in: scope };
  }

  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.invoice.count({ where }),
  ]);
  return { rows: rows.map(serializeInvoice), total };
}

/** Idempotent generation. Skips residents already invoiced for the period (unique constraint). */
export async function generateInvoices(tenantId: string, input: GenerateInvoiceInput) {
  const property = await prisma.property.findFirst({ where: { id: input.propertyId } });
  if (!property) throw Errors.notFound('Property not found');

  const residentWhere: Prisma.ResidentWhereInput = {
    propertyId: input.propertyId,
    status: 'active',
  };
  if (input.residentIds && input.residentIds.length) {
    residentWhere.id = { in: input.residentIds };
  }
  const residents = await prisma.resident.findMany({ where: residentWhere });

  const createdInvoices: ReturnType<typeof serializeInvoice>[] = [];
  let skipped = 0;

  for (const resident of residents) {
    const exists = await prisma.invoice.findFirst({
      where: {
        residentId: resident.id,
        periodMonth: input.periodMonth,
        periodYear: input.periodYear,
      },
    });
    if (exists) {
      skipped++;
      continue;
    }

    const pro = computeProRata(
      Number(resident.monthlyRent),
      input.periodYear,
      input.periodMonth,
      resident.checkInDate,
    );
    const subtotal = pro.amount;
    const dueDate = dueDateFor(input.periodYear, input.periodMonth, property.billingDay);

    try {
      const invoice = await prisma.$transaction(async (tx) => {
        const invoiceNumber = await nextInvoiceNumber(tx, tenantId, input.periodYear);
        return tx.invoice.create({
          data: {
            tenantId,
            invoiceNumber,
            propertyId: input.propertyId,
            roomId: resident.roomId,
            residentId: resident.id,
            periodMonth: input.periodMonth,
            periodYear: input.periodYear,
            dueDate,
            subtotal,
            lateFee: 0,
            totalAmount: subtotal,
            paidAmount: 0,
            status: 'unpaid',
            items: {
              create: [
                {
                  tenantId,
                  type: 'rent',
                  description: pro.prorated
                    ? `Sewa (pro-rata ${pro.daysCharged}/${pro.daysInMonth} hari)`
                    : 'Sewa bulanan',
                  quantity: 1,
                  unitPrice: subtotal,
                  amount: subtotal,
                },
              ],
            },
          },
        });
      });
      createdInvoices.push(serializeInvoice(invoice));
    } catch (e) {
      // Unique race → treat as skipped (idempotency).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        skipped++;
        continue;
      }
      throw e;
    }
  }

  return { created: createdInvoices.length, skipped, invoices: createdInvoices };
}

export async function createManualInvoice(tenantId: string, input: CreateInvoiceInput) {
  const resident = await prisma.resident.findFirst({ where: { id: input.residentId } });
  if (!resident) throw Errors.notFound('Resident not found');

  const subtotal = round2(input.items.reduce((s, it) => s + it.amount, 0));

  return prisma.$transaction(async (tx) => {
    const dup = await tx.invoice.findFirst({
      where: {
        residentId: input.residentId,
        periodMonth: input.periodMonth,
        periodYear: input.periodYear,
      },
    });
    if (dup) throw Errors.conflict('Invoice already exists for this resident and period');

    const invoiceNumber = await nextInvoiceNumber(tx, tenantId, input.periodYear);
    const invoice = await tx.invoice.create({
      data: {
        tenantId,
        invoiceNumber,
        propertyId: resident.propertyId,
        roomId: resident.roomId,
        residentId: resident.id,
        periodMonth: input.periodMonth,
        periodYear: input.periodYear,
        dueDate: new Date(input.dueDate),
        subtotal,
        lateFee: 0,
        totalAmount: subtotal,
        paidAmount: 0,
        status: 'unpaid',
        items: {
          create: input.items.map((it) => ({
            tenantId,
            type: it.type,
            description: it.description,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            amount: it.amount,
          })),
        },
      },
    });
    return serializeInvoice(invoice);
  });
}

async function getInvoice(id: string): Promise<InvoiceRow> {
  const inv = await prisma.invoice.findFirst({ where: { id } });
  if (!inv) throw Errors.notFound('Invoice not found');
  return inv;
}

export async function getInvoiceDetail(id: string) {
  const inv = await getInvoice(id);
  const [items, payments] = await Promise.all([
    prisma.invoiceItem.findMany({ where: { invoiceId: id } }),
    prisma.payment.findMany({ where: { invoiceId: id }, orderBy: { paidAt: 'desc' } }),
  ]);

  const paymentsOut = await Promise.all(
    payments.map(async (p) => ({
      id: p.id,
      invoiceId: p.invoiceId,
      amount: dec(p.amount),
      method: p.method,
      paidAt: iso(p.paidAt),
      reference: p.reference,
      proofUrl: await presignDownloadIfExists(p.proofKey),
      recordedBy: p.recordedBy,
    })),
  );

  return {
    ...serializeInvoice(inv),
    items: items.map((it) => ({
      id: it.id,
      type: it.type,
      description: it.description,
      quantity: dec(it.quantity),
      unitPrice: dec(it.unitPrice),
      amount: dec(it.amount),
    })),
    payments: paymentsOut,
  };
}

export async function updateInvoice(id: string, input: UpdateInvoiceInput) {
  const inv = await getInvoice(id);
  if (!['unpaid', 'partial'].includes(inv.status)) {
    throw Errors.conflict('Only unpaid/partial invoices can be edited');
  }
  const subtotal = round2(input.items.reduce((s, it) => s + it.amount, 0));
  const lateFee = Number(inv.lateFee);
  const totalAmount = round2(subtotal + lateFee);
  const paidAmount = Number(inv.paidAmount);
  const status = computeStatus(totalAmount, paidAmount, inv.dueDate);

  await prisma.$transaction([
    prisma.invoiceItem.deleteMany({ where: { invoiceId: id } }),
    prisma.invoiceItem.createMany({
      data: input.items.map((it) => ({
        tenantId: inv.tenantId,
        invoiceId: id,
        type: it.type,
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        amount: it.amount,
      })),
    }),
    prisma.invoice.update({
      where: { id },
      data: { subtotal, totalAmount, status, notes: input.notes ?? inv.notes },
    }),
  ]);
  return serializeInvoice(await getInvoice(id));
}

export async function cancelInvoice(id: string, reason: string) {
  const inv = await getInvoice(id);
  const paymentCount = await prisma.payment.count({ where: { invoiceId: id } });
  if (paymentCount > 0) throw Errors.conflict('Cannot cancel an invoice that has payments');
  if (inv.status === 'cancelled') throw Errors.conflict('Invoice already cancelled');

  const updated = await prisma.invoice.update({
    where: { id },
    data: { status: 'cancelled', notes: `${inv.notes ?? ''}\n[cancelled] ${reason}`.trim() },
  });
  return serializeInvoice(updated);
}

function computeStatus(total: number, paid: number, dueDate: Date): InvoiceRow['status'] {
  if (paid >= total && total > 0) return 'paid';
  if (paid > 0 && paid < total) return 'partial';
  if (paid === 0 && dueDate < new Date()) return 'overdue';
  return 'unpaid';
}

export async function recordPayment(id: string, userId: string, input: RecordPaymentInput) {
  const inv = await getInvoice(id);
  if (inv.status === 'cancelled') throw Errors.conflict('Cannot pay a cancelled invoice');

  const balance = round2(Number(inv.totalAmount) - Number(inv.paidAmount));
  if (input.amount > balance) {
    throw Errors.validation(`Payment ${input.amount} exceeds remaining balance ${balance}`);
  }

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        tenantId: inv.tenantId,
        invoiceId: id,
        amount: input.amount,
        method: input.method,
        paidAt: new Date(input.paidAt),
        reference: input.reference,
        proofKey: input.proofKey,
        recordedBy: userId,
      },
    });
    const newPaid = round2(Number(inv.paidAmount) + input.amount);
    const status = computeStatus(Number(inv.totalAmount), newPaid, inv.dueDate);
    await tx.invoice.update({ where: { id }, data: { paidAmount: newPaid, status } });
    return payment;
  });

  return {
    id: result.id,
    invoiceId: result.invoiceId,
    amount: dec(result.amount),
    method: result.method,
    paidAt: iso(result.paidAt),
    reference: result.reference,
    recordedBy: result.recordedBy,
  };
}

export async function markPaid(id: string, userId: string, method?: string, paidAt?: string) {
  const inv = await getInvoice(id);
  if (inv.status === 'cancelled') throw Errors.conflict('Cannot mark a cancelled invoice as paid');
  if (inv.status === 'paid') return serializeInvoice(inv);

  const balance = round2(Number(inv.totalAmount) - Number(inv.paidAmount));
  await prisma.$transaction(async (tx) => {
    if (balance > 0) {
      await tx.payment.create({
        data: {
          tenantId: inv.tenantId,
          invoiceId: id,
          amount: balance,
          method: (method as any) ?? 'cash',
          paidAt: paidAt ? new Date(paidAt) : new Date(),
          reference: 'mark-paid',
          recordedBy: userId,
        },
      });
    }
    await tx.invoice.update({
      where: { id },
      data: { paidAmount: inv.totalAmount, status: 'paid' },
    });
  });
  return serializeInvoice(await getInvoice(id));
}

export async function getInvoicePropertyId(id: string): Promise<string> {
  const inv = await getInvoice(id);
  return inv.propertyId;
}
