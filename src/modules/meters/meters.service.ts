import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, iso } from '../../utils/serialize';
import { assertPlanFeature } from '../../services/plan.service';
import { presignDownloadIfExists } from '../files/files.service';
import type {
  CreateMeterReadingInput,
  UpdateMeterReadingInput,
  ListMeterReadingQuery,
} from './meters.validators';

type MeterRow = Prisma.MeterReadingGetPayload<object>;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function serializeMeterReading(m: MeterRow) {
  return {
    id: m.id,
    propertyId: m.propertyId,
    roomId: m.roomId,
    type: m.type,
    periodMonth: m.periodMonth,
    periodYear: m.periodYear,
    previousReading: dec(m.previousReading),
    currentReading: dec(m.currentReading),
    usage: dec(m.usage),
    pricePerUnit: dec(m.pricePerUnit),
    amount: dec(m.amount),
    photoKey: m.photoKey,
    notes: m.notes,
    recordedByUserId: m.recordedByUserId,
    createdAt: iso(m.createdAt),
  };
}

async function getRoom(roomId: string) {
  const room = await prisma.room.findFirst({ where: { id: roomId } });
  if (!room) throw Errors.notFound('Room not found');
  return room;
}

async function getReading(id: string): Promise<MeterRow> {
  const m = await prisma.meterReading.findFirst({ where: { id } });
  if (!m) throw Errors.notFound('Meter reading not found');
  return m;
}

/** Resolve the property a reading belongs to (for property-scope access checks). */
export async function getReadingPropertyId(id: string): Promise<string> {
  return (await getReading(id)).propertyId;
}

/**
 * Most recent prior reading for a room+type, ordered by period (year, month) then createdAt.
 * "Prior" excludes the target period itself. Used to auto-derive `previousReading`.
 */
async function latestPriorReading(
  roomId: string,
  type: MeterRow['type'],
  periodYear: number,
  periodMonth: number,
): Promise<MeterRow | null> {
  const rows = await prisma.meterReading.findMany({
    where: {
      roomId,
      type,
      OR: [
        { periodYear: { lt: periodYear } },
        { periodYear, periodMonth: { lt: periodMonth } },
      ],
    },
    orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }, { createdAt: 'desc' }],
    take: 1,
  });
  return rows[0] ?? null;
}

export async function listReadingsByRoom(roomId: string, q: ListMeterReadingQuery) {
  await getRoom(roomId);
  const where: Prisma.MeterReadingWhereInput = { roomId };
  if (q.type) where.type = q.type;
  if (q.period_month) where.periodMonth = q.period_month;
  if (q.period_year) where.periodYear = q.period_year;

  const [rows, total] = await Promise.all([
    prisma.meterReading.findMany({
      where,
      orderBy: [{ periodYear: q.sort_order }, { periodMonth: q.sort_order }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.meterReading.count({ where }),
  ]);

  const out = await Promise.all(
    rows.map(async (r) => ({
      ...serializeMeterReading(r),
      photoUrl: await presignDownloadIfExists(r.photoKey),
    })),
  );
  return { rows: out, total };
}

export async function createReading(
  tenantId: string,
  roomId: string,
  userId: string,
  input: CreateMeterReadingInput,
) {
  // Plan gating — meter utility is Pro+ (PRD §12.2).
  await assertPlanFeature(tenantId, 'meterUtility');

  const room = await getRoom(roomId);

  // Resolve price: electricity defaults to property price; water requires explicit price.
  let pricePerUnit = input.pricePerUnit;
  if (pricePerUnit === undefined) {
    if (input.type === 'electricity') {
      const property = await prisma.property.findFirst({ where: { id: room.propertyId } });
      pricePerUnit = Number(property?.electricityPriceKwh ?? 0);
    } else {
      throw Errors.validation('pricePerUnit is required for water readings (no default price)');
    }
  }

  const prior = await latestPriorReading(roomId, input.type, input.periodYear, input.periodMonth);
  const previousReading = prior ? Number(prior.currentReading) : 0;

  if (input.currentReading < previousReading) {
    throw Errors.validation(
      `currentReading (${input.currentReading}) cannot be less than previousReading (${previousReading})`,
    );
  }

  const usage = round3(input.currentReading - previousReading);
  const amount = round2(usage * pricePerUnit);

  try {
    const created = await prisma.meterReading.create({
      data: {
        tenantId,
        propertyId: room.propertyId,
        roomId,
        type: input.type,
        periodMonth: input.periodMonth,
        periodYear: input.periodYear,
        previousReading,
        currentReading: input.currentReading,
        usage,
        pricePerUnit,
        amount,
        photoKey: input.photoKey,
        recordedByUserId: userId,
        notes: input.notes,
      },
    });
    return serializeMeterReading(created);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw Errors.conflict(
        `A ${input.type} reading already exists for this room and period ${input.periodMonth}/${input.periodYear}`,
      );
    }
    throw e;
  }
}

export async function updateReading(id: string, input: UpdateMeterReadingInput) {
  const existing = await getReading(id);

  const currentReading =
    input.currentReading !== undefined ? input.currentReading : Number(existing.currentReading);
  const pricePerUnit =
    input.pricePerUnit !== undefined ? input.pricePerUnit : Number(existing.pricePerUnit);
  const previousReading = Number(existing.previousReading);

  if (currentReading < previousReading) {
    throw Errors.validation(
      `currentReading (${currentReading}) cannot be less than previousReading (${previousReading})`,
    );
  }

  const usage = round3(currentReading - previousReading);
  const amount = round2(usage * pricePerUnit);

  const updated = await prisma.meterReading.update({
    where: { id },
    data: {
      currentReading,
      pricePerUnit,
      usage,
      amount,
      photoKey: input.photoKey ?? existing.photoKey,
      notes: input.notes ?? existing.notes,
    },
  });
  return serializeMeterReading(updated);
}

export async function deleteReading(id: string) {
  await getReading(id);
  await prisma.meterReading.delete({ where: { id } });
  return { id, deleted: true };
}

/**
 * Invoice-integration helper. Returns the meter readings (electricity/water) for a room in a
 * given billing period, as invoice-item shapes. Used by `generateInvoices`. Tenant-scoped via
 * the active AsyncLocalStorage context (same as the rest of the generation path).
 */
export async function meterItemsForInvoice(
  roomId: string,
  periodMonth: number,
  periodYear: number,
) {
  const readings = await prisma.meterReading.findMany({
    where: { roomId, periodMonth, periodYear },
  });

  const unitLabel: Record<string, string> = { electricity: 'KWh', water: 'm³' };
  return readings
    .filter((r) => Number(r.amount) > 0 || Number(r.usage) > 0)
    .map((r) => {
      const usage = Number(r.usage);
      const price = Number(r.pricePerUnit);
      const typeLabel = r.type === 'electricity' ? 'Listrik' : 'Air';
      return {
        type: r.type as 'electricity' | 'water',
        description: `${typeLabel}: ${usage} ${unitLabel[r.type]} × Rp${price}`,
        quantity: usage,
        unitPrice: price,
        amount: round2(Number(r.amount)),
      };
    });
}
