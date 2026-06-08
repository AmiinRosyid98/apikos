import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, iso } from '../../utils/serialize';
import { assertPlanCapacity } from '../../services/plan.service';
import type {
  CreateRoomInput,
  UpdateRoomInput,
  ListRoomQuery,
  CloneRoomInput,
  BulkPriceInput,
} from './rooms.validators';

type RoomRow = Prisma.RoomGetPayload<object>;

export function serializeRoom(r: RoomRow) {
  return {
    id: r.id,
    propertyId: r.propertyId,
    roomNumber: r.roomNumber,
    roomType: r.roomType,
    floor: r.floor,
    areaM2: dec(r.areaM2),
    basePrice: dec(r.basePrice),
    status: r.status,
    facilities: r.facilities,
    photos: r.photos,
    notes: r.notes,
    createdAt: iso(r.createdAt),
  };
}

async function assertPropertyExists(propertyId: string) {
  const p = await prisma.property.findFirst({ where: { id: propertyId } });
  if (!p) throw Errors.notFound('Property not found');
  return p;
}

async function getRoom(id: string): Promise<RoomRow> {
  const r = await prisma.room.findFirst({ where: { id } });
  if (!r) throw Errors.notFound('Room not found');
  return r;
}

export async function listRoomsByProperty(propertyId: string, q: ListRoomQuery) {
  await assertPropertyExists(propertyId);
  const where: Prisma.RoomWhereInput = { propertyId };
  if (q.status) where.status = q.status;
  if (q.room_type) where.roomType = q.room_type;

  const [rows, total] = await Promise.all([
    prisma.room.findMany({
      where,
      orderBy: { roomNumber: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.room.count({ where }),
  ]);
  return { rows: rows.map(serializeRoom), total, propertyId };
}

export async function createRoom(tenantId: string, propertyId: string, input: CreateRoomInput) {
  await assertPropertyExists(propertyId);
  await assertPlanCapacity(tenantId, 'room');
  const created = await prisma.room.create({
    data: {
      tenantId,
      propertyId,
      roomNumber: input.roomNumber,
      roomType: input.roomType,
      floor: input.floor,
      areaM2: input.areaM2,
      basePrice: input.basePrice,
      facilities: input.facilities ?? [],
      notes: input.notes,
    },
  });
  return serializeRoom(created);
}

export async function getRoomWithHistory(id: string) {
  const r = await getRoom(id);
  const occupancies = await prisma.occupancy.findMany({
    where: { roomId: id },
    orderBy: { startDate: 'desc' },
  });
  return {
    ...serializeRoom(r),
    occupancyHistory: occupancies.map((o) => ({
      id: o.id,
      residentId: o.residentId,
      monthlyRent: dec(o.monthlyRent),
      startDate: o.startDate.toISOString().slice(0, 10),
      endDate: o.endDate ? o.endDate.toISOString().slice(0, 10) : null,
      status: o.status,
      endReason: o.endReason,
    })),
  };
}

export async function updateRoom(id: string, input: UpdateRoomInput) {
  await getRoom(id);
  const updated = await prisma.room.update({
    where: { id },
    data: {
      roomNumber: input.roomNumber,
      roomType: input.roomType,
      floor: input.floor,
      areaM2: input.areaM2,
      basePrice: input.basePrice,
      facilities: input.facilities ?? undefined,
      notes: input.notes,
    },
  });
  return serializeRoom(updated);
}

export async function setRoomStatus(id: string, status: RoomRow['status']) {
  await getRoom(id);
  const updated = await prisma.room.update({ where: { id }, data: { status } });
  return serializeRoom(updated);
}

export async function cloneRoom(tenantId: string, id: string, input: CloneRoomInput) {
  const src = await getRoom(id);
  await assertPlanCapacity(tenantId, 'room', input.count);

  const prefix = input.roomNumberPrefix ?? src.roomNumber;
  const created: RoomRow[] = [];
  for (let i = 1; i <= input.count; i++) {
    const roomNumber = `${prefix}-${i}`;
    const room = await prisma.room.create({
      data: {
        tenantId: src.tenantId,
        propertyId: src.propertyId,
        roomNumber,
        roomType: src.roomType,
        floor: src.floor,
        areaM2: src.areaM2,
        basePrice: src.basePrice,
        facilities: src.facilities as Prisma.InputJsonValue,
        notes: src.notes,
        status: 'empty',
      },
    });
    created.push(room);
  }
  return created.map(serializeRoom);
}

export async function bulkPrice(propertyId: string, input: BulkPriceInput) {
  await assertPropertyExists(propertyId);
  const where: Prisma.RoomWhereInput = { propertyId };
  if (input.filter.roomType) where.roomType = input.filter.roomType;

  const rooms = await prisma.room.findMany({ where, select: { id: true, basePrice: true } });
  let updated = 0;
  for (const room of rooms) {
    const current = Number(room.basePrice);
    const next =
      input.adjustType === 'percent'
        ? Math.round(current * (1 + input.value / 100) * 100) / 100
        : Math.max(0, current + input.value);
    await prisma.room.update({ where: { id: room.id }, data: { basePrice: next } });
    updated++;
  }
  return { updated };
}

export async function appendPhotos(id: string, keys: string[]) {
  const r = await getRoom(id);
  const existing = Array.isArray(r.photos) ? (r.photos as string[]) : [];
  const merged = [...existing, ...keys];
  const updated = await prisma.room.update({
    where: { id },
    data: { photos: merged as Prisma.InputJsonValue },
  });
  return serializeRoom(updated);
}

export async function getRoomPropertyId(id: string): Promise<string> {
  const r = await getRoom(id);
  return r.propertyId;
}
