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
      // Acquisition / investment value for the ROI report (PRD §6.12 tambahan, §19) — Rp500jt.
      investmentValue: 500_000_000,
      // Public landing + booking link enabled so the frontend can demo /p/kos-melati out of the box
      // (PRD §6.2, §6.13). GET /api/v1/public/properties/kos-melati + POST .../bookings work immediately.
      publicSlug: 'kos-melati',
      publicEnabled: true,
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
  const demoInvoice = await prisma.invoice.create({
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

  // A PAID invoice for last month + its recorded payment, so the Tax (PPh) and ROI reports show
  // non-zero collected revenue out of the box (the current-period INV-...000001 stays UNPAID).
  // Payment is dated within THIS year so it lands in the tax/ROI year window.
  const prevPeriod = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  await prisma.tenantCounter.update({
    where: { tenantId: tenant.id },
    data: { invoiceSeq: 2 },
  });
  const paidInvoice = await prisma.invoice.create({
    data: {
      tenantId: tenant.id,
      invoiceNumber: `INV-${now.getFullYear()}-000002`,
      propertyId: property.id,
      roomId: rooms[0].id,
      residentId: resident.id,
      periodMonth: prevPeriod.getUTCMonth() + 1,
      periodYear: prevPeriod.getUTCFullYear(),
      dueDate: new Date(Date.UTC(prevPeriod.getUTCFullYear(), prevPeriod.getUTCMonth(), 5)),
      subtotal: 800000,
      lateFee: 0,
      totalAmount: 800000,
      paidAmount: 800000,
      status: 'paid',
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
  await prisma.payment.create({
    data: {
      tenantId: tenant.id,
      invoiceId: paidInvoice.id,
      amount: 800000,
      method: 'transfer',
      paidAt: new Date(Date.UTC(now.getFullYear(), Math.max(0, now.getMonth() - 1), 6)),
      recordedBy: owner.id,
    },
  });

  // One demo PENDING booking on room A2 (so the frontend has booking data out of the box).
  // Booking holds the room → A2 status set to `booking`. feeDueAt is in the future so the
  // auto-release job leaves it alone (PRD §6.13). Idempotent with the reseed (tenant is wiped
  // and recreated each run, so room A2 always starts `empty` here).
  const roomA2 = rooms[1];
  await prisma.booking.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      roomId: roomA2.id,
      prospectName: 'Calon Penghuni Demo',
      prospectPhone: '081377778888',
      prospectEmail: 'calon@example.com',
      plannedCheckInDate: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 20)),
      bookingFeeAmount: 200000,
      bookingFeeMethod: 'transfer',
      feeStatus: 'unpaid',
      feeDueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // +7d (won't auto-expire)
      status: 'pending',
      notes: 'Demo booking — menunggu konfirmasi pembayaran booking fee',
      recordedByUserId: owner.id,
    },
  });
  await prisma.room.update({ where: { id: roomA2.id }, data: { status: 'booking' } });

  // ── Maintenance Module (PRD §6.14) — 1 vendor + 1 open ticket on room A1 so the frontend has
  // data out of the box. Idempotent with the reseed (tenant wiped + recreated each run). The
  // ticketNumber uses the same tenant_counters pattern as invoices (TKT-{YEAR}-{SEQ}).
  await prisma.vendor.create({
    data: {
      tenantId: tenant.id,
      name: 'Pak Joko - Listrik',
      skill: 'listrik',
      phone: '081255556666',
      rating: 4.5,
      notes: 'Tukang listrik langganan; respons cepat.',
      isActive: true,
    },
  });
  const roomA1 = rooms[0];
  const ticketYear = now.getFullYear();
  await prisma.$transaction(async (tx) => {
    // Bump the per-tenant maintenance counter (the counter row was created with the tenant).
    const counter = await tx.tenantCounter.update({
      where: { tenantId: tenant.id },
      data: { maintenanceSeqYear: ticketYear, maintenanceSeq: 1 },
    });
    await tx.maintenanceTicket.create({
      data: {
        tenantId: tenant.id,
        propertyId: property.id,
        roomId: roomA1.id,
        ticketNumber: `TKT-${ticketYear}-${String(counter.maintenanceSeq).padStart(4, '0')}`,
        title: 'Lampu kamar mati',
        description: 'Penghuni melaporkan lampu utama kamar A1 tidak menyala sejak kemarin.',
        category: 'listrik',
        priority: 'medium',
        status: 'open',
        photoKeys: [],
        cost: 0,
        reportedByUserId: owner.id,
      },
    });
  });

  // ── Dokumen & Kontrak (PRD §6.15) — 1 default contract template (tenant default, propertyId
  // null) + 1 draft contract for Budi + 1 demo document so the frontend has data out of the box.
  // Idempotent with the reseed (tenant wiped + recreated each run). Kept inline (no src/ import
  // coupling, matching this seed's convention; mirrors contracts.templates.ts DEFAULT_CONTRACT_TEMPLATE
  // + the {var} render).
  const CONTRACT_TEMPLATE_BODY = [
    'SURAT PERJANJIAN SEWA KAMAR KOS',
    '',
    'Pada hari ini, {tanggal_hari_ini}, yang bertanda tangan di bawah ini menyepakati perjanjian sewa kamar kos dengan ketentuan sebagai berikut:',
    '',
    'PIHAK PENYEWA',
    'Nama       : {nama_penyewa}',
    'NIK        : {nik}',
    '',
    'OBJEK SEWA',
    'Nama Kos   : {nama_kos}',
    'Alamat     : {alamat}',
    'Nomor Kamar: {nomor_kamar}',
    '',
    'KETENTUAN SEWA',
    '1. Harga sewa per bulan sebesar {harga_sewa}.',
    '2. Masa sewa dimulai pada {tanggal_masuk} sampai dengan {tanggal_keluar}.',
    '3. Pembayaran sewa dilakukan setiap bulan sesuai tanggal yang disepakati.',
    '4. Penyewa wajib menjaga kebersihan dan ketertiban serta mematuhi peraturan kos.',
    '5. Kerusakan yang disebabkan oleh penyewa menjadi tanggung jawab penyewa.',
    '',
    'Demikian perjanjian ini dibuat dengan sebenarnya untuk dipatuhi oleh kedua belah pihak.',
  ].join('\n');

  const contractTemplate = await prisma.contractTemplate.create({
    data: {
      tenantId: tenant.id,
      propertyId: null,
      name: 'Kontrak Sewa Kamar Kos (Default)',
      body: CONTRACT_TEMPLATE_BODY,
      isActive: true,
    },
  });

  // Render a stable snapshot for Budi's draft contract (one year from check-in).
  const contractStart = checkIn;
  const contractEnd = new Date(Date.UTC(checkIn.getUTCFullYear() + 1, checkIn.getUTCMonth(), checkIn.getUTCDate()));
  const fmtTanggal = (d: Date) =>
    d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtRupiah = (n: number) => `Rp${Math.round(n).toLocaleString('id-ID')}`;
  const contractVars: Record<string, string> = {
    nama_penyewa: resident.fullName,
    nik: '3201234567890001',
    nomor_kamar: roomA1.roomNumber,
    nama_kos: property.name,
    alamat: `${property.address}, ${property.city}, ${property.province}`,
    harga_sewa: fmtRupiah(800000),
    tanggal_masuk: fmtTanggal(contractStart),
    tanggal_keluar: fmtTanggal(contractEnd),
    tanggal_hari_ini: fmtTanggal(now),
  };
  const renderedBody = CONTRACT_TEMPLATE_BODY.replace(/\{(\w+)\}/g, (m, k: string) =>
    contractVars[k] !== undefined ? contractVars[k] : m,
  );
  await prisma.tenantCounter.update({
    where: { tenantId: tenant.id },
    data: { contractSeqYear: now.getFullYear(), contractSeq: 1 },
  });
  await prisma.contract.create({
    data: {
      tenantId: tenant.id,
      residentId: resident.id,
      propertyId: property.id,
      roomId: roomA1.id,
      templateId: contractTemplate.id,
      contractNumber: `KTR-${now.getFullYear()}-0001`,
      body: renderedBody,
      status: 'draft',
      startDate: contractStart,
      endDate: contractEnd,
      createdByUserId: owner.id,
    },
  });

  // 1 demo document (KTP scan) expiring in ~20 days so the documents/expiring view has data.
  await prisma.documentRecord.create({
    data: {
      tenantId: tenant.id,
      residentId: resident.id,
      propertyId: property.id,
      type: 'ktp',
      name: 'KTP Budi Santoso',
      fileKey: 'documents/demo/ktp-budi.jpg',
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      notes: 'Scan KTP penghuni.',
      uploadedByUserId: owner.id,
    },
  });

  // ── WhatsApp default templates (PRD §6.9) — tenant defaults (propertyId null), Indonesian. ──
  // Kept inline (no src/ import coupling, matching this seed's convention). Mirrors
  // src/modules/whatsapp/whatsapp.templates.ts DEFAULT_TEMPLATES.
  const WA_DEFAULT_TEMPLATES: {
    type: 'invoice_new' | 'reminder_due' | 'reminder_overdue' | 'payment_received' | 'contract_expiry' | 'broadcast';
    name: string;
    body: string;
  }[] = [
    {
      type: 'invoice_new',
      name: 'Tagihan Baru',
      body:
        'Halo {nama_penyewa}, tagihan sewa kamar {nomor_kamar} di {nama_kos} sebesar ' +
        '{jumlah_tagihan} telah terbit. Mohon dibayar sebelum {jatuh_tempo}. Terima kasih.',
    },
    {
      type: 'reminder_due',
      name: 'Pengingat Jatuh Tempo',
      body:
        'Halo {nama_penyewa}, ini pengingat tagihan sewa kamar {nomor_kamar} di {nama_kos} sebesar ' +
        '{jumlah_tagihan} yang jatuh tempo pada {jatuh_tempo}. Mohon segera dibayar. Terima kasih.',
    },
    {
      type: 'reminder_overdue',
      name: 'Pengingat Tunggakan',
      body:
        'Halo {nama_penyewa}, tagihan sewa kamar {nomor_kamar} di {nama_kos} sebesar ' +
        '{jumlah_tagihan} telah melewati jatuh tempo ({jatuh_tempo}). Mohon segera melakukan ' +
        'pembayaran untuk menghindari denda. Terima kasih.',
    },
    {
      type: 'payment_received',
      name: 'Pembayaran Diterima',
      body:
        'Halo {nama_penyewa}, pembayaran sewa kamar {nomor_kamar} di {nama_kos} sebesar ' +
        '{jumlah_tagihan} telah kami terima. Terima kasih atas pembayaran Anda.',
    },
    {
      type: 'contract_expiry',
      name: 'Kontrak Akan Berakhir',
      body:
        'Halo {nama_penyewa}, masa sewa kamar {nomor_kamar} di {nama_kos} akan berakhir pada ' +
        '{jatuh_tempo}. Mohon konfirmasi perpanjangan sewa. Terima kasih.',
    },
    {
      type: 'broadcast',
      name: 'Pengumuman',
      body: 'Halo {nama_penyewa}, ada pengumuman dari pengelola {nama_kos}: ',
    },
  ];
  for (const t of WA_DEFAULT_TEMPLATES) {
    await prisma.waTemplate.create({
      data: { tenantId: tenant.id, propertyId: null, type: t.type, name: t.name, body: t.body },
    });
  }

  // A couple of demo wa_messages (STUB mode — recorded but not sent) so the log view has data.
  await prisma.waMessage.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      residentId: resident.id,
      invoiceId: demoInvoice.id,
      toPhone: resident.phone,
      toName: resident.fullName,
      templateType: 'invoice_new',
      body:
        `Halo ${resident.fullName}, tagihan sewa kamar A1 di ${property.name} sebesar ` +
        `Rp800.000 telah terbit. Mohon dibayar sebelum 5 ${now.toLocaleDateString('id-ID', { month: 'long' })} ${now.getFullYear()}. Terima kasih.`,
      status: 'stub',
      provider: 'stub',
      providerMessageId: 'stub-demo-0001',
      sentByUserId: owner.id,
    },
  });
  await prisma.waMessage.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      residentId: resident.id,
      toPhone: resident.phone,
      toName: resident.fullName,
      templateType: 'broadcast',
      body: `Halo ${resident.fullName}, ada pengumuman dari pengelola ${property.name}: kerja bakti hari Minggu.`,
      status: 'stub',
      provider: 'stub',
      providerMessageId: 'stub-demo-0002',
      sentByUserId: owner.id,
    },
  });

  // ── In-App Notifications (PRD §6.18) — 2 demo notifications for the owner ──
  // One unread (booking_new) + one read (contract_expiring) so the badge + list have data and the
  // frontend can show both states out of the box. Idempotent with the reseed (tenant wiped first).
  await prisma.notification.create({
    data: {
      tenantId: tenant.id,
      userId: owner.id,
      type: 'booking_new',
      title: 'Booking baru',
      body: 'Booking baru dari Andi Wijaya untuk kamar A2.',
      link: '/bookings',
      entityType: 'booking',
      isRead: false,
    },
  });
  await prisma.notification.create({
    data: {
      tenantId: tenant.id,
      userId: owner.id,
      type: 'contract_expiring',
      title: 'Kontrak akan berakhir',
      body: `Kontrak Budi Santoso (kamar A1) di ${property.name} berakhir dalam 20 hari.`,
      link: `/residents/${resident.id}`,
      entityType: 'resident',
      entityId: resident.id,
      isRead: true,
      readAt: new Date(),
    },
  });

  console.log('\n✅ Seed complete.');
  console.log(`   Tenant : ${tenant.name} (${tenant.slug})`);
  console.log(`   Accounts (all password: ${password}):`);
  console.log(`     - ${owner.email}  [owner]`);
  for (const u of team) console.log(`     - ${u.email}  [${u.role}]`);
  console.log(`   Property: ${property.name} with ${rooms.length} rooms`);
  console.log('   Resident: Budi Santoso (room A1) + 1 unpaid invoice');
  console.log('   Booking : 1 pending booking (room A2, status=booking)');
  console.log('   Maintenance: 1 vendor (Pak Joko - Listrik) + 1 open ticket (room A1)');
  console.log('   WhatsApp: 6 default templates + 2 demo messages (status=stub)');
  console.log('   Kontrak : 1 default contract template + 1 draft contract (Budi) + 1 KTP document (expiring)');
  console.log('   Notifikasi: 2 demo notifications for the owner (1 unread booking_new + 1 read contract_expiring)\n');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
