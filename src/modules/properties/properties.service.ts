import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dec, iso } from '../../utils/serialize';
import { assertPlanCapacity } from '../../services/plan.service';
import type {
  CreatePropertyInput,
  UpdatePropertyInput,
  ListPropertyQuery,
} from './properties.validators';

type PropertyRow = Prisma.PropertyGetPayload<object>;

export function serializeProperty(p: PropertyRow) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    address: p.address,
    city: p.city,
    province: p.province,
    lat: dec(p.lat),
    lng: dec(p.lng),
    facilities: p.facilities,
    billingDay: p.billingDay,
    lateFeeType: p.lateFeeType,
    lateFeeValue: dec(p.lateFeeValue),
    lateFeeGraceDays: p.lateFeeGraceDays,
    electricityPriceKwh: dec(p.electricityPriceKwh),
    isActive: p.isActive,
    createdAt: iso(p.createdAt),
  };
}

export async function listProperties(q: ListPropertyQuery, scope: string[] | undefined) {
  const where: Prisma.PropertyWhereInput = {};
  if (q.type) where.type = q.type;
  if (q.city) where.city = { contains: q.city, mode: 'insensitive' };
  if (q.is_active !== undefined) where.isActive = q.is_active;
  if (scope !== undefined) where.id = { in: scope };

  const [rows, total] = await Promise.all([
    prisma.property.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.property.count({ where }),
  ]);
  return { rows: rows.map(serializeProperty), total };
}

export async function createProperty(tenantId: string, input: CreatePropertyInput) {
  await assertPlanCapacity(tenantId, 'property');
  const created = await prisma.property.create({
    data: {
      tenantId,
      name: input.name,
      type: input.type,
      address: input.address,
      city: input.city,
      province: input.province,
      lat: input.lat,
      lng: input.lng,
      facilities: input.facilities ?? [],
      billingDay: input.billingDay ?? 1,
      lateFeeType: input.lateFeeType ?? 'flat',
      lateFeeValue: input.lateFeeValue ?? 0,
      lateFeeGraceDays: input.lateFeeGraceDays ?? 0,
      electricityPriceKwh: input.electricityPriceKwh ?? 0,
    },
  });
  return serializeProperty(created);
}

async function getOwnedProperty(id: string): Promise<PropertyRow> {
  const p = await prisma.property.findFirst({ where: { id } });
  if (!p) throw Errors.notFound('Property not found');
  return p;
}

export async function getPropertyWithStats(id: string) {
  const p = await getOwnedProperty(id);

  const [totalRooms, occupied, empty, activeInvoices] = await Promise.all([
    prisma.room.count({ where: { propertyId: id } }),
    prisma.room.count({ where: { propertyId: id, status: 'occupied' } }),
    prisma.room.count({ where: { propertyId: id, status: 'empty' } }),
    prisma.invoice.findMany({
      where: { propertyId: id, status: { in: ['unpaid', 'partial', 'overdue'] } },
      select: { totalAmount: true, paidAmount: true },
    }),
  ]);

  const now = new Date();
  const monthRevenueAgg = await prisma.payment.aggregate({
    _sum: { amount: true },
    where: {
      invoice: { propertyId: id },
      paidAt: {
        gte: new Date(now.getFullYear(), now.getMonth(), 1),
        lt: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      },
    },
  });

  const outstanding = activeInvoices.reduce(
    (sum, inv) => sum + (Number(inv.totalAmount) - Number(inv.paidAmount)),
    0,
  );
  const occupancyRate = totalRooms > 0 ? Math.round((occupied / totalRooms) * 10000) / 100 : 0;

  return {
    ...serializeProperty(p),
    stats: {
      totalRooms,
      occupied,
      empty,
      occupancyRate,
      monthlyRevenue: Number(monthRevenueAgg._sum.amount ?? 0),
      outstanding,
    },
  };
}

export async function updateProperty(id: string, input: UpdatePropertyInput) {
  await getOwnedProperty(id);
  const updated = await prisma.property.update({
    where: { id },
    data: {
      name: input.name,
      type: input.type,
      address: input.address,
      city: input.city,
      province: input.province,
      lat: input.lat,
      lng: input.lng,
      facilities: input.facilities ?? undefined,
      billingDay: input.billingDay,
      lateFeeType: input.lateFeeType,
      lateFeeValue: input.lateFeeValue,
      lateFeeGraceDays: input.lateFeeGraceDays,
      electricityPriceKwh: input.electricityPriceKwh,
    },
  });
  return serializeProperty(updated);
}

export async function deactivateProperty(id: string) {
  await getOwnedProperty(id);
  const updated = await prisma.property.update({
    where: { id },
    data: { isActive: false },
  });
  return { id: updated.id, isActive: updated.isActive };
}
