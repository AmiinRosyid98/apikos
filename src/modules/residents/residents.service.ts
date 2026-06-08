import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, dateOnly, iso } from '../../utils/serialize';
import { encryptNullable, decryptNullable } from '../../utils/crypto';
import { presignDownloadIfExists } from '../files/files.service';
import type {
  CreateResidentInput,
  UpdateResidentInput,
  ListResidentQuery,
  MoveResidentInput,
  CheckoutResidentInput,
} from './residents.validators';

type ResidentRow = Prisma.ResidentGetPayload<object>;

/** List/base serializer — PII masked (no decrypted nik, no doc urls). */
export function serializeResident(r: ResidentRow) {
  return {
    id: r.id,
    propertyId: r.propertyId,
    roomId: r.roomId,
    fullName: r.fullName,
    nikMasked: r.nikLast4 ? `************${r.nikLast4}` : null,
    phone: r.phone,
    email: r.email,
    occupation: r.occupation,
    gender: r.gender,
    status: r.status,
    monthlyRent: dec(r.monthlyRent),
    checkInDate: dateOnly(r.checkInDate),
    contractEndDate: dateOnly(r.contractEndDate),
    checkOutDate: dateOnly(r.checkOutDate),
    internalNotes: r.internalNotes,
    createdAt: iso(r.createdAt),
  };
}

async function getResident(id: string): Promise<ResidentRow> {
  const r = await prisma.resident.findFirst({ where: { id } });
  if (!r) throw Errors.notFound('Resident not found');
  return r;
}

async function assertRoomInProperty(propertyId: string, roomId: string) {
  const room = await prisma.room.findFirst({ where: { id: roomId, propertyId } });
  if (!room) throw Errors.notFound('Room not found in property');
  return room;
}

export async function listResidents(q: ListResidentQuery, scope: string[] | undefined) {
  const where: Prisma.ResidentWhereInput = {};
  if (q.status) where.status = q.status;
  if (q.property_id) where.propertyId = q.property_id;
  if (q.room_id) where.roomId = q.room_id;
  if (q.q) {
    where.OR = [
      { fullName: { contains: q.q, mode: 'insensitive' } },
      { phone: { contains: q.q } },
      { nikLast4: { contains: q.q } },
    ];
  }
  if (scope !== undefined) where.propertyId = { in: scope, ...(q.property_id ? {} : {}) };
  if (scope !== undefined && q.property_id) {
    where.propertyId = scope.includes(q.property_id) ? q.property_id : '__none__';
  }

  const [rows, total] = await Promise.all([
    prisma.resident.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.resident.count({ where }),
  ]);
  return { rows: rows.map(serializeResident), total };
}

export async function createResident(input: CreateResidentInput) {
  const room = await assertRoomInProperty(input.propertyId, input.roomId);
  const tenantId = room.tenantId;

  // Encrypt PII (A6).
  const nikEnc = encryptNullable(input.nik ?? null);
  const nikLast4 = input.nik ? input.nik.slice(-4) : null;
  const ktpPhotoKeyEnc = encryptNullable(input.ktpKey ?? null);

  return prisma.$transaction(async (tx) => {
    const resident = await tx.resident.create({
      data: {
        tenantId,
        propertyId: input.propertyId,
        roomId: input.roomId,
        fullName: input.fullName,
        nikEnc,
        nikLast4,
        phone: input.phone,
        email: input.email,
        occupation: input.occupation,
        gender: input.gender,
        ktpPhotoKeyEnc,
        selfieKey: input.selfieKey,
        emergencyName: input.emergencyContact.name,
        emergencyPhone: input.emergencyContact.phone,
        emergencyRelation: input.emergencyContact.relation,
        monthlyRent: input.monthlyRent,
        checkInDate: new Date(input.checkInDate),
        contractEndDate: input.contractEndDate ? new Date(input.contractEndDate) : null,
        internalNotes: input.internalNotes,
        status: 'active',
      },
    });

    // Open occupancy + set room occupied (occupancy = tenancy history, fix b).
    await tx.occupancy.create({
      data: {
        tenantId,
        residentId: resident.id,
        propertyId: input.propertyId,
        roomId: input.roomId,
        monthlyRent: input.monthlyRent,
        startDate: new Date(input.checkInDate),
        status: 'active',
      },
    });
    await tx.room.update({ where: { id: input.roomId }, data: { status: 'occupied' } });

    return resident;
  }).then(serializeResident);
}

export async function getResidentDetail(id: string, canSeeRawNik: boolean) {
  const r = await getResident(id);
  const occupancies = await prisma.occupancy.findMany({
    where: { residentId: id },
    orderBy: { startDate: 'desc' },
  });

  const ktpKey = decryptNullable(r.ktpPhotoKeyEnc);
  const [ktpUrl, selfieUrl] = await Promise.all([
    presignDownloadIfExists(ktpKey),
    presignDownloadIfExists(r.selfieKey),
  ]);

  return {
    ...serializeResident(r),
    nik: canSeeRawNik ? decryptNullable(r.nikEnc) : undefined,
    emergencyContact: {
      name: r.emergencyName,
      phone: r.emergencyPhone,
      relation: r.emergencyRelation,
    },
    documents: { ktpUrl, selfieUrl },
    occupancyHistory: occupancies.map((o) => ({
      id: o.id,
      roomId: o.roomId,
      monthlyRent: dec(o.monthlyRent),
      startDate: dateOnly(o.startDate),
      endDate: dateOnly(o.endDate),
      status: o.status,
      endReason: o.endReason,
    })),
  };
}

export async function updateResident(id: string, input: UpdateResidentInput) {
  const existing = await getResident(id);
  const data: Prisma.ResidentUpdateInput = {
    fullName: input.fullName,
    phone: input.phone,
    email: input.email,
    occupation: input.occupation,
    gender: input.gender,
    monthlyRent: input.monthlyRent,
    contractEndDate: input.contractEndDate ? new Date(input.contractEndDate) : undefined,
    internalNotes: input.internalNotes,
  };
  if (input.nik !== undefined) {
    data.nikEnc = encryptNullable(input.nik);
    data.nikLast4 = input.nik ? input.nik.slice(-4) : null;
  }
  if (input.ktpKey !== undefined) data.ktpPhotoKeyEnc = encryptNullable(input.ktpKey);
  if (input.selfieKey !== undefined) data.selfieKey = input.selfieKey;
  if (input.emergencyContact) {
    data.emergencyName = input.emergencyContact.name;
    data.emergencyPhone = input.emergencyContact.phone;
    data.emergencyRelation = input.emergencyContact.relation;
  }

  await prisma.resident.update({ where: { id: existing.id }, data });
  return serializeResident(await getResident(id));
}

export async function moveResident(id: string, input: MoveResidentInput) {
  const resident = await getResident(id);
  if (resident.status !== 'active') throw Errors.conflict('Only active residents can move');
  const newRoom = await assertRoomInProperty(resident.propertyId, input.newRoomId);
  if (newRoom.status === 'occupied') throw Errors.conflict('Target room is occupied');

  await prisma.$transaction(async (tx) => {
    // Close current active occupancy
    await tx.occupancy.updateMany({
      where: { residentId: id, status: 'active' },
      data: { status: 'ended', endDate: new Date(input.effectiveDate), endReason: 'moved' },
    });
    // Free old room
    if (resident.roomId) {
      await tx.room.update({ where: { id: resident.roomId }, data: { status: 'empty' } });
    }
    // Open new occupancy + occupy new room
    await tx.occupancy.create({
      data: {
        tenantId: resident.tenantId,
        residentId: id,
        propertyId: resident.propertyId,
        roomId: input.newRoomId,
        monthlyRent: resident.monthlyRent,
        startDate: new Date(input.effectiveDate),
        status: 'active',
      },
    });
    await tx.room.update({ where: { id: input.newRoomId }, data: { status: 'occupied' } });
    await tx.resident.update({ where: { id }, data: { roomId: input.newRoomId } });
  });

  return serializeResident(await getResident(id));
}

export async function checkoutResident(id: string, input: CheckoutResidentInput) {
  const resident = await getResident(id);
  if (resident.status === 'alumni') throw Errors.conflict('Resident already checked out');

  await prisma.$transaction(async (tx) => {
    await tx.occupancy.updateMany({
      where: { residentId: id, status: 'active' },
      data: { status: 'ended', endDate: new Date(input.checkOutDate), endReason: 'checkout' },
    });
    if (resident.roomId) {
      await tx.room.update({ where: { id: resident.roomId }, data: { status: 'empty' } });
    }
    await tx.resident.update({
      where: { id },
      data: {
        status: 'alumni',
        checkOutDate: new Date(input.checkOutDate),
        roomId: null,
        internalNotes: input.notes ?? resident.internalNotes,
      },
    });
  });

  return serializeResident(await getResident(id));
}

export async function setResidentStatus(id: string, status: ResidentRow['status']) {
  const resident = await getResident(id);
  await prisma.resident.update({ where: { id: resident.id }, data: { status } });
  return serializeResident(await getResident(id));
}

export async function getResidentPropertyId(id: string): Promise<string> {
  const r = await getResident(id);
  return r.propertyId;
}
