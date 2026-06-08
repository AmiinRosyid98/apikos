import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

/**
 * Seed: one demo tenant + owner + property + rooms (+ a resident & invoice for demo data).
 * Uses a raw PrismaClient (no tenant-guard) so it can write across tenant boundaries directly.
 *
 * Demo credentials: owner@demo.kos / Password123!
 */
const prisma = new PrismaClient();

// Mirror crypto util (AES-256-GCM) so seed has no src/ import coupling.
const KEY = Buffer.from(process.env.ENCRYPTION_KEY as string, 'hex');
function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

async function main() {
  const email = 'owner@demo.kos';
  const password = 'Password123!';
  const passwordHash = await bcrypt.hash(password, 12);

  // Clean prior demo tenant (idempotent reseed).
  const existing = await prisma.tenant.findUnique({ where: { slug: 'demo-kos' } });
  if (existing) {
    await prisma.tenant.delete({ where: { id: existing.id } });
    console.log('Removed existing demo tenant for reseed.');
  }

  const tenant = await prisma.tenant.create({
    data: {
      name: 'Demo Kos',
      slug: 'demo-kos',
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      subscriptionExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      maxProperties: 5,
      maxRooms: 150,
      maxUsers: 10,
      counter: { create: {} },
    },
  });

  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email,
      passwordHash,
      fullName: 'Demo Owner',
      phone: '081200000000',
      role: 'owner',
      isActive: true,
      emailVerifiedAt: new Date(),
    },
  });

  // Additional team accounts — one per role, for RBAC testing. Same password.
  const teamSeed = [
    { email: 'manager@demo.kos', fullName: 'Demo Manager', phone: '081200000001', role: 'manager' as const },
    { email: 'admin@demo.kos', fullName: 'Demo Admin', phone: '081200000002', role: 'admin' as const },
    { email: 'finance@demo.kos', fullName: 'Demo Finance', phone: '081200000003', role: 'finance' as const },
  ];
  const team = [];
  for (const t of teamSeed) {
    team.push(
      await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: t.email,
          passwordHash, // same hash → password "Password123!"
          fullName: t.fullName,
          phone: t.phone,
          role: t.role,
          isActive: true,
          emailVerifiedAt: new Date(),
        },
      }),
    );
  }

  const property = await prisma.property.create({
    data: {
      tenantId: tenant.id,
      name: 'Kos Melati',
      type: 'campur',
      address: 'Jl. Mawar No. 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      facilities: ['wifi', 'parkir', 'dapur'],
      billingDay: 1,
      lateFeeType: 'flat',
      lateFeeValue: 25000,
      lateFeeGraceDays: 3,
      electricityPriceKwh: 1500,
    },
  });

  const roomsData = [
    { roomNumber: 'A1', roomType: 'standard', floor: 1, basePrice: 800000, status: 'empty' as const },
    { roomNumber: 'A2', roomType: 'standard', floor: 1, basePrice: 800000, status: 'empty' as const },
    { roomNumber: 'A3', roomType: 'deluxe', floor: 1, basePrice: 1200000, status: 'empty' as const },
    { roomNumber: 'B1', roomType: 'deluxe', floor: 2, basePrice: 1250000, status: 'empty' as const },
  ];
  const rooms = [];
  for (const r of roomsData) {
    rooms.push(
      await prisma.room.create({
        data: {
          tenantId: tenant.id,
          propertyId: property.id,
          roomNumber: r.roomNumber,
          roomType: r.roomType,
          floor: r.floor,
          basePrice: r.basePrice,
          status: r.status,
          facilities: ['kasur', 'lemari'],
        },
      }),
    );
  }

  // One demo resident occupying room A1 + an unpaid invoice.
  const checkIn = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1));
  const resident = await prisma.resident.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      roomId: rooms[0].id,
      fullName: 'Budi Santoso',
      nikEnc: encrypt('3201234567890001'),
      nikLast4: '0001',
      phone: '081299990000',
      email: 'budi@example.com',
      gender: 'male',
      monthlyRent: 800000,
      checkInDate: checkIn,
      status: 'active',
    },
  });
  await prisma.occupancy.create({
    data: {
      tenantId: tenant.id,
      residentId: resident.id,
      propertyId: property.id,
      roomId: rooms[0].id,
      monthlyRent: 800000,
      startDate: checkIn,
      status: 'active',
    },
  });
  await prisma.room.update({ where: { id: rooms[0].id }, data: { status: 'occupied' } });

  const now = new Date();
  await prisma.tenantCounter.update({
    where: { tenantId: tenant.id },
    data: { invoiceSeqYear: now.getFullYear(), invoiceSeq: 1 },
  });
  await prisma.invoice.create({
    data: {
      tenantId: tenant.id,
      invoiceNumber: `INV-${now.getFullYear()}-000001`,
      propertyId: property.id,
      roomId: rooms[0].id,
      residentId: resident.id,
      periodMonth: now.getMonth() + 1,
      periodYear: now.getFullYear(),
      dueDate: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 5)),
      subtotal: 800000,
      lateFee: 0,
      totalAmount: 800000,
      paidAmount: 0,
      status: 'unpaid',
      items: {
        create: [
          {
            tenantId: tenant.id,
            type: 'rent',
            description: 'Sewa bulanan',
            quantity: 1,
            unitPrice: 800000,
            amount: 800000,
          },
        ],
      },
    },
  });

  // Default expense categories (Finance / Keuangan — PRD §6.12).
  const DEFAULT_EXPENSE_CATEGORIES = [
    'Listrik PLN',
    'Internet',
    'Kebersihan',
    'Maintenance',
    'Gaji/Upah',
    'Lainnya',
  ];
  for (const name of DEFAULT_EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.create({
      data: { tenantId: tenant.id, name, isDefault: true },
    });
  }

  // One demo expense (this month) so cash flow / P&L have data out of the box.
  const listrik = await prisma.expenseCategory.findFirst({
    where: { tenantId: tenant.id, name: 'Listrik PLN' },
  });
  if (listrik) {
    await prisma.expense.create({
      data: {
        tenantId: tenant.id,
        propertyId: property.id,
        categoryId: listrik.id,
        amount: 350000,
        date: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 10)),
        description: 'Tagihan listrik area bersama',
        vendorName: 'PLN',
        recordedByUserId: owner.id,
      },
    });
  }

  console.log('\n✅ Seed complete.');
  console.log(`   Tenant : ${tenant.name} (${tenant.slug})`);
  console.log(`   Accounts (all password: ${password}):`);
  console.log(`     - ${owner.email}  [owner]`);
  for (const u of team) console.log(`     - ${u.email}  [${u.role}]`);
  console.log(`   Property: ${property.name} with ${rooms.length} rooms`);
  console.log('   Resident: Budi Santoso (room A1) + 1 unpaid invoice\n');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
