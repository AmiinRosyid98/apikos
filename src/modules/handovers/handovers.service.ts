import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, dateOnly, iso } from '../../utils/serialize';
import { assertPlanFeature } from '../../services/plan.service';
import { presignDownloadIfExists } from '../files/files.service';
import type { CreateHandoverInput, InventoryItem, ListHandoversByResidentQuery } from './handovers.validators';

type HandoverRow = Prisma.HandoverRecordGetPayload<object>;

/** Inventory is stored as JSON; narrow it back to the typed shape on read. */
function readInventory(value: Prisma.JsonValue | null): InventoryItem[] {
  if (!Array.isArray(value)) return [];
  return value as unknown as InventoryItem[];
}
function readPhotoKeys(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function serializeHandover(h: HandoverRow) {
  return {
    id: h.id,
    residentId: h.residentId,
    propertyId: h.propertyId,
    roomId: h.roomId,
    type: h.type,
    date: dateOnly(h.date),
    photoKeys: readPhotoKeys(h.photoKeys),
    inventory: readInventory(h.inventory),
    initialMeterElectricity: dec(h.initialMeterElectricity),
    signatureKey: h.signatureKey,
    notes: h.notes,
    recordedByUserId: h.recordedByUserId,
    createdAt: iso(h.createdAt),
  };
}

async function getResident(id: string) {
  const r = await prisma.resident.findFirst({ where: { id } });
  if (!r) throw Errors.notFound('Resident not found');
  return r;
}

async function getHandover(id: string): Promise<HandoverRow> {
  const h = await prisma.handoverRecord.findFirst({ where: { id } });
  if (!h) throw Errors.notFound('Handover record not found');
  return h;
}

/** Resolve the property a handover belongs to (for property-scope access checks). */
export async function getHandoverPropertyId(id: string): Promise<string> {
  return (await getHandover(id)).propertyId;
}

export async function getResidentPropertyId(id: string): Promise<string> {
  return (await getResident(id)).propertyId;
}

export async function listByResident(residentId: string, q: ListHandoversByResidentQuery) {
  await getResident(residentId);
  const where: Prisma.HandoverRecordWhereInput = { residentId };
  if (q.type) where.type = q.type;

  const [rows, total] = await Promise.all([
    prisma.handoverRecord.findMany({
      where,
      orderBy: { date: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.handoverRecord.count({ where }),
  ]);
  return { rows: rows.map(serializeHandover), total };
}

export interface CreateHandoverResult {
  handover: ReturnType<typeof serializeHandover>;
  meterSeeded: boolean;
  meterSeedNote?: string;
}

/**
 * Create a handover record. For a `checkin` with `initialMeterElectricity` provided, we
 * optionally seed an electricity meter reading so the running-meter chain starts from the
 * documented value. The number is always persisted on the handover regardless of whether the
 * meter seed succeeds (so the berita acara is complete even if the meter module rejects).
 */
export async function createHandover(
  tenantId: string,
  residentId: string,
  userId: string,
  input: CreateHandoverInput,
): Promise<CreateHandoverResult> {
  // Plan gating — check-in/out is Pro+ (PRD §12.2).
  await assertPlanFeature(tenantId, 'checkinOut');

  const resident = await getResident(residentId);

  // initialMeterElectricity is only meaningful on check-in.
  const initialMeter =
    input.type === 'checkin' ? input.initialMeterElectricity ?? null : null;

  const created = await prisma.handoverRecord.create({
    data: {
      tenantId,
      residentId,
      propertyId: resident.propertyId,
      roomId: resident.roomId,
      type: input.type,
      date: new Date(input.date),
      photoKeys: input.photoKeys,
      inventory: input.inventory as unknown as Prisma.InputJsonValue,
      initialMeterElectricity: initialMeter,
      signatureKey: input.signatureKey,
      notes: input.notes,
      recordedByUserId: userId,
    },
  });

  // ── Meter seed seam (check-in only) ──
  // We do NOT hard-couple to the meters module: a meter reading requires a unique
  // (room,type,period) + a photoKey, which a handover may not satisfy. We attempt a best-effort
  // seed only when we can do so cleanly; otherwise we just keep the number on the handover and
  // flag the seam. This keeps the existing meters tests/behaviour untouched.
  let meterSeeded = false;
  let meterSeedNote: string | undefined;
  if (input.type === 'checkin' && initialMeter !== null && resident.roomId) {
    const d = new Date(input.date);
    const periodMonth = d.getUTCMonth() + 1;
    const periodYear = d.getUTCFullYear();
    const photoKey = input.photoKeys[0]; // meter reading requires a photo key
    if (!photoKey) {
      meterSeedNote =
        'initialMeterElectricity stored on the handover but NOT seeded as a meter reading: a meter reading requires a photoKey (foto meteran wajib) and none was supplied. Create the reading manually via POST /rooms/:id/meter-readings.';
    } else {
      try {
        const existing = await prisma.meterReading.findFirst({
          where: {
            roomId: resident.roomId,
            type: 'electricity',
            periodMonth,
            periodYear,
          },
        });
        if (existing) {
          meterSeedNote =
            'initialMeterElectricity stored on the handover but NOT seeded: an electricity reading already exists for this room/period.';
        } else {
          const property = await prisma.property.findFirst({
            where: { id: resident.propertyId },
          });
          const price = Number(property?.electricityPriceKwh ?? 0);
          await prisma.meterReading.create({
            data: {
              tenantId,
              propertyId: resident.propertyId,
              roomId: resident.roomId,
              type: 'electricity',
              periodMonth,
              periodYear,
              previousReading: 0,
              currentReading: initialMeter,
              usage: 0, // baseline reading on check-in → no usage to bill yet
              pricePerUnit: price,
              amount: 0,
              photoKey,
              recordedByUserId: userId,
              notes: 'Seeded from check-in handover (initial meter reading).',
            },
          });
          meterSeeded = true;
          meterSeedNote = 'Electricity meter baseline seeded for the check-in period (usage=0).';
        }
      } catch {
        meterSeedNote =
          'initialMeterElectricity stored on the handover; meter seed skipped due to a conflict/error. Create the reading manually if needed.';
      }
    }
  }

  return { handover: serializeHandover(created), meterSeeded, meterSeedNote };
}

/** Detail view with presigned URLs for photoKeys + signatureKey. */
export async function getHandoverDetail(id: string) {
  const h = await getHandover(id);
  const base = serializeHandover(h);

  const [photos, signatureUrl] = await Promise.all([
    Promise.all(
      base.photoKeys.map(async (key) => ({ key, url: await presignDownloadIfExists(key) })),
    ),
    presignDownloadIfExists(base.signatureKey),
  ]);

  return { ...base, photos, signatureUrl };
}

/**
 * Load the full context the PDF generator needs (property/room/resident names + the handover).
 * Tenant-scoped via the active context.
 */
export async function getHandoverForPdf(id: string) {
  const h = await getHandover(id);
  const [resident, property, room] = await Promise.all([
    prisma.resident.findFirst({ where: { id: h.residentId } }),
    prisma.property.findFirst({ where: { id: h.propertyId } }),
    h.roomId ? prisma.room.findFirst({ where: { id: h.roomId } }) : Promise.resolve(null),
  ]);

  return {
    handover: serializeHandover(h),
    resident: resident
      ? { id: resident.id, fullName: resident.fullName, phone: resident.phone }
      : null,
    property: property
      ? { id: property.id, name: property.name, address: property.address, city: property.city }
      : null,
    room: room ? { id: room.id, roomNumber: room.roomNumber, roomType: room.roomType } : null,
  };
}

export type HandoverPdfContext = Awaited<ReturnType<typeof getHandoverForPdf>>;
