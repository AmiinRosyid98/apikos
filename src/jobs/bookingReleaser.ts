import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../config/tenantStore';
import { prisma } from '../config/database';

/**
 * Booking auto-release (PRD §6.13). A repeatable job (default every 15 min, env
 * BOOKING_RELEASE_CRON) that finds `pending` bookings whose booking fee is still `unpaid` and
 * whose `feeDueAt` has passed, marks them `expired`, and releases the held room
 * (`booking` → `empty`).
 *
 * Mirrors the invoiceGenerator job pattern:
 *   - PURE function `runBookingRelease(data)` (no BullMQ dependency) → directly testable.
 *   - IDEMPOTENT: only acts on bookings still `pending`+`unpaid`+overdue; re-runs find nothing
 *     to do. The room release is guarded (only releases a room still in `booking` status).
 *   - PER-TENANT scoped: each tenant's mutations run inside `runWithTenant` so the Prisma
 *     tenant-guard auto-scopes every query — identical mechanism to the manual endpoints/seed.
 *     Cross-tenant ENUMERATION of due bookings uses a raw (un-extended) client, explicitly
 *     grouped by tenant.
 *   - FAILURE ISOLATION: try/catch per tenant and per booking — one failure never aborts the run.
 *   - STRUCTURED LOGS: run.start / booking.released / tenant.error / run.done.
 *
 * Confirmed bookings (fee paid) are NEVER auto-released — only `pending` + `unpaid` expire.
 */

// Raw (un-extended) client for CROSS-TENANT enumeration only — same approach as invoiceGenerator.
const rawPrisma = new PrismaClient();

export interface BookingReleaseJobData {
  /** "as-of" instant the run evaluates feeDueAt against. Defaults to now. Tests pass a value. */
  asOf?: string;
  /** Restrict the run to a single tenant (admin on-demand / tests). Omit = all tenants. */
  tenantId?: string;
  /** Free-form label for logs (e.g. "cron", "test"). */
  source?: string;
}

export interface ReleasedBooking {
  bookingId: string;
  // Nullable: a room-less PUBLIC inquiry has no room to release (PRD §6.13).
  roomId: string | null;
  roomReleased: boolean;
}

export interface TenantReleaseResult {
  tenantId: string;
  released: number;
  bookings: ReleasedBooking[];
  error?: string;
}

export interface BookingReleaseSummary {
  asOf: string;
  tenantsScanned: number;
  totalReleased: number;
  tenants: TenantReleaseResult[];
  durationMs: number;
}

function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    job: 'booking-release',
    event,
    ...fields,
  });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

/**
 * Execute one booking-release run. Pure function over `data` (no BullMQ dependency) so it is
 * directly unit/integration-testable. The worker processor and the test both call this.
 */
export async function runBookingRelease(
  data: BookingReleaseJobData = {},
): Promise<BookingReleaseSummary> {
  const startedAt = Date.now();
  const asOf = data.asOf ? new Date(data.asOf) : new Date();

  log('info', 'run.start', {
    source: data.source ?? 'cron',
    asOf: asOf.toISOString(),
    tenantFilter: data.tenantId ?? null,
  });

  // Enumerate all due bookings across tenants (raw, explicitly filtered). A booking is "due" when
  // it is still pending, the fee is unpaid, and feeDueAt < asOf.
  const dueBookings = await rawPrisma.booking.findMany({
    where: {
      status: 'pending',
      feeStatus: 'unpaid',
      feeDueAt: { lt: asOf },
      ...(data.tenantId ? { tenantId: data.tenantId } : {}),
    },
    select: { id: true, tenantId: true, roomId: true },
  });

  // Group due bookings by tenant for per-tenant scoped processing.
  const byTenant = new Map<string, { id: string; roomId: string | null }[]>();
  for (const b of dueBookings) {
    const list = byTenant.get(b.tenantId) ?? [];
    list.push({ id: b.id, roomId: b.roomId });
    byTenant.set(b.tenantId, list);
  }

  const tenantResults: TenantReleaseResult[] = [];
  let totalReleased = 0;

  for (const [tenantId, bookings] of byTenant) {
    const tenantResult: TenantReleaseResult = { tenantId, released: 0, bookings: [] };
    try {
      await runWithTenant({ tenantId }, async () => {
        for (const b of bookings) {
          try {
            const released = await releaseOne(b.id, asOf);
            if (released) {
              tenantResult.released++;
              totalReleased++;
              tenantResult.bookings.push(released);
              log('info', 'booking.released', {
                tenantId,
                bookingId: released.bookingId,
                roomId: released.roomId,
                roomReleased: released.roomReleased,
              });
            }
          } catch (e) {
            log('error', 'booking.error', {
              tenantId,
              bookingId: b.id,
              error: (e as Error).message,
            });
          }
        }
      });
    } catch (e) {
      tenantResult.error = (e as Error).message;
      log('error', 'tenant.error', { tenantId, error: tenantResult.error });
    }
    tenantResults.push(tenantResult);
  }

  const summary: BookingReleaseSummary = {
    asOf: asOf.toISOString(),
    tenantsScanned: byTenant.size,
    totalReleased,
    tenants: tenantResults,
    durationMs: Date.now() - startedAt,
  };

  log('info', 'run.done', {
    source: data.source ?? 'cron',
    tenantsScanned: summary.tenantsScanned,
    totalReleased: summary.totalReleased,
    durationMs: summary.durationMs,
  });

  return summary;
}

/**
 * Expire one booking + release its room, inside a transaction. Re-checks the booking is still
 * pending/unpaid/overdue (idempotency under races) before acting. Returns null if nothing to do.
 * Runs inside the tenant scope (caller wraps in runWithTenant) so the guard auto-scopes queries.
 */
async function releaseOne(bookingId: string, asOf: Date): Promise<ReleasedBooking | null> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findFirst({ where: { id: bookingId } });
    if (
      !booking ||
      booking.status !== 'pending' ||
      booking.feeStatus !== 'unpaid' ||
      booking.feeDueAt >= asOf
    ) {
      return null; // already acted on / no longer due — idempotent no-op
    }

    await tx.booking.update({ where: { id: bookingId }, data: { status: 'expired' } });

    // Release the room only if it is still held by this booking (status `booking`). A room-less
    // public inquiry (roomId null) simply expires with no room to release.
    let roomReleased = false;
    if (booking.roomId) {
      const room = await tx.room.findFirst({ where: { id: booking.roomId } });
      if (room && room.status === 'booking') {
        await tx.room.update({ where: { id: booking.roomId }, data: { status: 'empty' } });
        roomReleased = true;
      }
    }

    return { bookingId, roomId: booking.roomId, roomReleased };
  });
}

/** Release the raw client (used by the worker shutdown + test teardown). */
export async function disconnectBookingReleaser(): Promise<void> {
  await rawPrisma.$disconnect();
}
