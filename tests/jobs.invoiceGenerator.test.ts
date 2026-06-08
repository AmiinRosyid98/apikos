/**
 * Idempotency + billing-day correctness test for the scheduled invoice-generation cron.
 *
 * Proves PRD Risk #2 mitigation: running generation twice for a billing-day scenario does
 * NOT duplicate invoices (2nd run generates 0, skips all), and a NON-billing-day produces
 * nothing.
 *
 * Runs directly against the DB (no live HTTP server / worker needed) by calling the exact
 * `runInvoiceGeneration` function the BullMQ worker calls. Run with:
 *   node --require ts-node/register --test tests/jobs.invoiceGenerator.test.ts
 * (see `npm run test:jobs`). Creates + tears down its own isolated tenant fixtures.
 */
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runInvoiceGeneration, disconnectInvoiceGenerator } from '../src/jobs/invoiceGenerator';

const raw = new PrismaClient();

// Asia/Jakarta day-of-month for a given instant (matches the generator's WIB logic).
function wibDay(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', day: '2-digit' });
  return Number(fmt.formatToParts(at).find((p) => p.type === 'day')?.value);
}

// Fixture: a fresh tenant + owner counter + property + active resident. billingDay is set to
// the WIB day-of `asOf` so the cron matches this property exactly on that date.
let tenantId: string;
let propertyId: string;
let residentId: string;
const asOf = new Date(); // today; period = current month
const billingDay = wibDay(asOf);

before(async () => {
  const tenant = await raw.tenant.create({
    data: {
      name: `JobTest ${Date.now()}`,
      slug: `jobtest-${Date.now()}`,
      subscriptionPlan: 'pro',
      subscriptionStatus: 'active',
      subscriptionExpiresAt: new Date(Date.now() + 14 * 864e5),
      maxProperties: 5,
      maxRooms: 50,
      maxUsers: 10,
      counter: { create: {} },
    },
  });
  tenantId = tenant.id;

  const property = await raw.property.create({
    data: {
      tenantId,
      name: 'Job Test Kos',
      type: 'campur',
      address: 'Jl Cron 1',
      city: 'Bandung',
      province: 'Jawa Barat',
      billingDay, // <-- matches WIB day of `asOf`
      isActive: true,
    },
  });
  propertyId = property.id;

  const room = await raw.room.create({
    data: { tenantId, propertyId, roomNumber: 'C1', roomType: 'standard', basePrice: 900000, status: 'occupied' },
  });

  // Check-in on the 1st of the current month so there is NO pro-rata (full rent), keeping the
  // assertions simple. Pro-rata itself is covered by the manual-path tests.
  const checkIn = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const resident = await raw.resident.create({
    data: {
      tenantId,
      propertyId,
      roomId: room.id,
      fullName: 'Cron Resident',
      nikEnc: 'x.x.x',
      nikLast4: '0000',
      phone: '081200000000',
      gender: 'male',
      monthlyRent: 900000,
      checkInDate: checkIn,
      status: 'active',
    },
  });
  residentId = resident.id;
});

after(async () => {
  // Cascade delete the whole tenant fixture.
  if (tenantId) await raw.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await raw.$disconnect();
  await disconnectInvoiceGenerator();
});

test('billing day: first run generates exactly one invoice for the active resident', async () => {
  const summary = await runInvoiceGeneration({ asOf: asOf.toISOString(), tenantId, source: 'test' });

  const t = summary.tenants.find((x) => x.tenantId === tenantId);
  assert.ok(t, 'tenant should appear in summary');
  assert.equal(t.generated, 1, `expected 1 generated, got ${t.generated}`);
  assert.equal(t.skipped, 0, `expected 0 skipped on first run, got ${t.skipped}`);

  const count = await raw.invoice.count({
    where: { tenantId, residentId, periodMonth: asOf.getUTCMonth() + 1, periodYear: asOf.getUTCFullYear() },
  });
  assert.equal(count, 1, 'exactly one invoice row should exist');
});

test('IDEMPOTENCY: second run on the same billing day generates 0, skips all, no duplicates', async () => {
  const summary = await runInvoiceGeneration({ asOf: asOf.toISOString(), tenantId, source: 'test' });

  const t = summary.tenants.find((x) => x.tenantId === tenantId);
  assert.ok(t, 'tenant should appear in summary');
  assert.equal(t.generated, 0, `2nd run must generate 0, got ${t.generated}`);
  assert.equal(t.skipped, 1, `2nd run must skip the existing resident, got ${t.skipped}`);

  // The unique (tenant, resident, period) constraint guarantees no duplicate row.
  const count = await raw.invoice.count({
    where: { tenantId, residentId, periodMonth: asOf.getUTCMonth() + 1, periodYear: asOf.getUTCFullYear() },
  });
  assert.equal(count, 1, 'still exactly one invoice after re-run (no duplicate)');
});

test('non-billing-day: a date whose day != property.billingDay produces nothing', async () => {
  // Pick an as-of date guaranteed not to equal billingDay (shift by 1, wrap within 1..28).
  const otherDay = billingDay === 1 ? 2 : 1;
  const nonBilling = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), otherDay, 5, 0, 0));
  assert.notEqual(wibDay(nonBilling), billingDay, 'sanity: chosen date must differ from billingDay');

  const summary = await runInvoiceGeneration({ asOf: nonBilling.toISOString(), tenantId, source: 'test' });

  const t = summary.tenants.find((x) => x.tenantId === tenantId);
  // The property is not matched at all on a non-billing day.
  assert.equal(summary.propertiesMatched, 0, `no property should match, got ${summary.propertiesMatched}`);
  assert.equal(t ? t.generated : 0, 0, 'no invoices generated on a non-billing day');
});
