import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, dateOnly, iso } from '../../utils/serialize';
import { assertPlanFeature } from '../../services/plan.service';
import type {
  CreateDepositInput,
  RefundDepositInput,
  ListDepositsByResidentQuery,
  ListDepositsReportQuery,
} from './deposits.validators';

type DepositRow = Prisma.DepositRecordGetPayload<object>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function serializeDeposit(d: DepositRow) {
  return {
    id: d.id,
    residentId: d.residentId,
    propertyId: d.propertyId,
    roomId: d.roomId,
    amount: dec(d.amount),
    method: d.method,
    receivedDate: dateOnly(d.receivedDate),
    status: d.status,
    refundedAmount: dec(d.refundedAmount),
    refundedDate: dateOnly(d.refundedDate),
    deductionAmount: dec(d.deductionAmount),
    deductionNotes: d.deductionNotes,
    notes: d.notes,
    recordedByUserId: d.recordedByUserId,
    createdAt: iso(d.createdAt),
  };
}

async function getResident(id: string) {
  const r = await prisma.resident.findFirst({ where: { id } });
  if (!r) throw Errors.notFound('Resident not found');
  return r;
}

async function getDeposit(id: string): Promise<DepositRow> {
  const d = await prisma.depositRecord.findFirst({ where: { id } });
  if (!d) throw Errors.notFound('Deposit record not found');
  return d;
}

/** Resolve the property a deposit belongs to (for property-scope access checks). */
export async function getDepositPropertyId(id: string): Promise<string> {
  return (await getDeposit(id)).propertyId;
}

/** Resolve the property a resident belongs to (for property-scope access checks). */
export async function getResidentPropertyId(id: string): Promise<string> {
  return (await getResident(id)).propertyId;
}

export async function listByResident(residentId: string, q: ListDepositsByResidentQuery) {
  await getResident(residentId);
  const where: Prisma.DepositRecordWhereInput = { residentId };
  if (q.status) where.status = q.status;

  const [rows, total] = await Promise.all([
    prisma.depositRecord.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.depositRecord.count({ where }),
  ]);
  return { rows: rows.map(serializeDeposit), total };
}

export async function createDeposit(
  tenantId: string,
  residentId: string,
  userId: string,
  input: CreateDepositInput,
) {
  // Plan gating — deposit management is Pro+ (PRD §12.2).
  await assertPlanFeature(tenantId, 'depositManagement');

  const resident = await getResident(residentId);

  const created = await prisma.depositRecord.create({
    data: {
      tenantId,
      residentId,
      propertyId: resident.propertyId,
      roomId: resident.roomId,
      amount: input.amount,
      method: input.method,
      receivedDate: new Date(input.receivedDate),
      status: 'held',
      notes: input.notes,
      recordedByUserId: userId,
    },
  });
  return serializeDeposit(created);
}

/**
 * Record a refund/forfeit. Validates `refundedAmount + deductionAmount <= amount` (422).
 * Resulting status:
 *   - refundedAmount === amount (no deduction, fully returned) → `refunded`
 *   - refundedAmount === 0                                     → `forfeited`
 *   - otherwise (some returned, some kept)                     → `partially_refunded`
 */
export async function refundDeposit(
  tenantId: string,
  depositId: string,
  input: RefundDepositInput,
) {
  await assertPlanFeature(tenantId, 'depositManagement');

  const deposit = await getDeposit(depositId);
  const amount = Number(deposit.amount);
  const refundedAmount = round2(input.refundedAmount);
  const deductionAmount = round2(input.deductionAmount);

  if (deposit.status === 'refunded' || deposit.status === 'forfeited') {
    throw Errors.conflict(`Deposit is already ${deposit.status} and cannot be refunded again`);
  }

  const total = round2(refundedAmount + deductionAmount);
  if (total > amount) {
    throw Errors.validation(
      `refundedAmount (${refundedAmount}) + deductionAmount (${deductionAmount}) = ${total} exceeds the deposit amount (${amount})`,
    );
  }

  let status: DepositRow['status'];
  if (refundedAmount === 0) {
    status = 'forfeited';
  } else if (refundedAmount === amount) {
    status = 'refunded';
  } else {
    status = 'partially_refunded';
  }

  const updated = await prisma.depositRecord.update({
    where: { id: depositId },
    data: {
      refundedAmount,
      deductionAmount,
      deductionNotes: input.deductionNotes,
      refundedDate: new Date(input.refundedDate),
      status,
    },
  });
  return serializeDeposit(updated);
}

/**
 * Outstanding-deposits report (Manager+/Finance). Defaults to status=held — deposits not yet
 * refunded. Property-scope is applied by the controller via the `scope` allowlist.
 */
export async function listReport(q: ListDepositsReportQuery, scope: string[] | undefined) {
  const where: Prisma.DepositRecordWhereInput = {};
  where.status = q.status ?? 'held';
  if (q.property_id) where.propertyId = q.property_id;
  if (scope !== undefined) {
    where.propertyId =
      q.property_id && scope.includes(q.property_id)
        ? q.property_id
        : { in: q.property_id ? ['__none__'] : scope };
  }

  const [rows, total, totals] = await Promise.all([
    prisma.depositRecord.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.depositRecord.count({ where }),
    prisma.depositRecord.aggregate({ where, _sum: { amount: true } }),
  ]);
  return {
    rows: rows.map(serializeDeposit),
    total,
    totalAmount: dec(totals._sum.amount) ?? 0,
  };
}
