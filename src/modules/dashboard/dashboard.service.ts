import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { serializeProperty } from '../properties/properties.service';

function monthRange(d = new Date()) {
  return {
    gte: new Date(d.getFullYear(), d.getMonth(), 1),
    lt: new Date(d.getFullYear(), d.getMonth() + 1, 1),
  };
}

export async function overview(scope: string[] | undefined) {
  const propFilter: Prisma.PropertyWhereInput = { isActive: true };
  if (scope !== undefined) propFilter.id = { in: scope };

  const properties = await prisma.property.findMany({ where: propFilter, select: { id: true } });
  const propertyIds = properties.map((p) => p.id);
  const roomScope: Prisma.RoomWhereInput =
    scope !== undefined ? { propertyId: { in: propertyIds } } : {};
  const invScopeBase: Prisma.InvoiceWhereInput =
    scope !== undefined ? { propertyId: { in: propertyIds } } : {};

  const [totalProperties, totalRooms, occupied, activeResidents] = await Promise.all([
    prisma.property.count({ where: propFilter }),
    prisma.room.count({ where: roomScope }),
    prisma.room.count({ where: { ...roomScope, status: 'occupied' } }),
    prisma.resident.count({
      where: scope !== undefined ? { propertyId: { in: propertyIds }, status: 'active' } : { status: 'active' },
    }),
  ]);

  const monthRevenueAgg = await prisma.payment.aggregate({
    _sum: { amount: true },
    where: {
      paidAt: monthRange(),
      ...(scope !== undefined ? { invoice: { propertyId: { in: propertyIds } } } : {}),
    },
  });

  const outstandingInvoices = await prisma.invoice.findMany({
    where: { ...invScopeBase, status: { in: ['unpaid', 'partial', 'overdue'] } },
    select: { totalAmount: true, paidAmount: true },
  });
  const outstandingAmount = outstandingInvoices.reduce(
    (s, i) => s + (Number(i.totalAmount) - Number(i.paidAmount)),
    0,
  );

  const occupancyRate = totalRooms > 0 ? Math.round((occupied / totalRooms) * 10000) / 100 : 0;

  return {
    totalProperties,
    totalRooms,
    occupied,
    occupancyRate,
    monthRevenue: Number(monthRevenueAgg._sum.amount ?? 0),
    outstandingAmount,
    outstandingCount: outstandingInvoices.length,
    activeResidents,
  };
}

export async function propertyDashboard(id: string) {
  const property = await prisma.property.findFirst({ where: { id } });
  if (!property) throw Errors.notFound('Property not found');

  const [totalRooms, occupied, statusGroups] = await Promise.all([
    prisma.room.count({ where: { propertyId: id } }),
    prisma.room.count({ where: { propertyId: id, status: 'occupied' } }),
    prisma.room.groupBy({ by: ['status'], where: { propertyId: id }, _count: true }),
  ]);

  const monthRevenueAgg = await prisma.payment.aggregate({
    _sum: { amount: true },
    where: { invoice: { propertyId: id }, paidAt: monthRange() },
  });

  const outstandingInvoices = await prisma.invoice.findMany({
    where: { propertyId: id, status: { in: ['unpaid', 'partial', 'overdue'] } },
    select: { totalAmount: true, paidAmount: true },
  });
  const outstanding = outstandingInvoices.reduce(
    (s, i) => s + (Number(i.totalAmount) - Number(i.paidAmount)),
    0,
  );

  const roomStatusBreakdown = statusGroups.reduce<Record<string, number>>((acc, g) => {
    acc[g.status] = g._count as unknown as number;
    return acc;
  }, {});

  // Trends: last 6 months. Occupancy trend approximated from current occupancy (full history
  // requires occupancy snapshots — MVP-2). Revenue trend from payments per month.
  const trends = await buildTrends(id);

  return {
    property: serializeProperty(property),
    occupancyRate: totalRooms > 0 ? Math.round((occupied / totalRooms) * 10000) / 100 : 0,
    monthRevenue: Number(monthRevenueAgg._sum.amount ?? 0),
    outstanding,
    roomStatusBreakdown,
    occupancyTrend: trends.occupancyTrend,
    revenueTrend: trends.revenueTrend,
  };
}

async function buildTrends(propertyId: string) {
  const now = new Date();
  const occupancyTrend: { month: string; rate: number }[] = [];
  const revenueTrend: { month: string; realized: number; target: number }[] = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    const realizedAgg = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { invoice: { propertyId }, paidAt: { gte: d, lt: next } },
    });
    const targetAgg = await prisma.invoice.aggregate({
      _sum: { totalAmount: true },
      where: { propertyId, periodYear: d.getFullYear(), periodMonth: d.getMonth() + 1 },
    });

    revenueTrend.push({
      month: monthLabel,
      realized: Number(realizedAgg._sum.amount ?? 0),
      target: Number(targetAgg._sum.totalAmount ?? 0),
    });

    // Occupancy active during that month (occupancies overlapping the month).
    const activeOcc = await prisma.occupancy.count({
      where: {
        propertyId,
        startDate: { lt: next },
        OR: [{ endDate: null }, { endDate: { gte: d } }],
      },
    });
    const totalRooms = await prisma.room.count({ where: { propertyId } });
    occupancyTrend.push({
      month: monthLabel,
      rate: totalRooms > 0 ? Math.round((activeOcc / totalRooms) * 10000) / 100 : 0,
    });
  }
  return { occupancyTrend, revenueTrend };
}
