import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { runWithTenant } from '../../config/tenantStore';
import { Errors } from '../../utils/errors';
import { dec } from '../../utils/serialize';
import { notify } from '../../services/notification.service';
import { featuresForPlan } from '../../services/plan.service';
import { buildBrandingPayload } from '../branding/branding.service';
import type { PublicBookingInput } from './public.validators';

/**
 * PUBLIC service (PRD §6.2 landing publik, §6.13 link booking publik).
 *
 * These flows are UNAUTHENTICATED and have NO request tenant context. The tenant + property are
 * resolved STRICTLY from the URL slug:
 *   1. A raw (un-extended) Prisma client looks up the property by its globally-unique `public_slug`
 *      (the tenant-guard cannot help here — there is no tenant yet). Only `public_enabled` rows are
 *      considered "found"; a disabled OR unknown slug yields the SAME 404 (no existence/state leak).
 *   2. Everything after resolution runs inside `runWithTenant({ tenantId })`, so every read/write is
 *      auto-scoped by the Prisma tenant-guard to the slug's tenant — exactly like the payment webhook
 *      and the cron jobs. The public caller can therefore NEVER touch another tenant's data.
 *
 * Marketing-safe ONLY: responses expose property/room marketing fields and nothing else (no tenant,
 * owner, financial, or resident data).
 */

// Raw client for the cross-tenant slug lookup ONLY (no tenant context exists at that point). Every
// subsequent query uses the tenant-guarded `prisma` inside runWithTenant.
const rawPrisma = new PrismaClient();

/** Default public booking-fee deadline: now + 48h (PRD §6.13 — documented default for public leads). */
const PUBLIC_FEE_WINDOW_MS = 48 * 60 * 60 * 1000;

interface ResolvedProperty {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  address: string;
  city: string;
  province: string;
  facilities: Prisma.JsonValue;
}

/**
 * Resolve an ENABLED public property by slug, or throw 404. Disabled/unknown → identical 404 so the
 * existence (and the disabled vs missing distinction) is never revealed.
 */
async function resolveEnabledProperty(slug: string): Promise<ResolvedProperty> {
  const p = await rawPrisma.property.findFirst({
    where: { publicSlug: slug, publicEnabled: true, isActive: true },
    select: {
      id: true,
      tenantId: true,
      name: true,
      type: true,
      address: true,
      city: true,
      province: true,
      facilities: true,
    },
  });
  if (!p) throw Errors.notFound('Property not found');
  return p;
}

/**
 * GET marketing-safe property info + AVAILABLE (empty) rooms only + a price range. Returns ONLY
 * public-safe fields. Rate-limited at the route layer.
 */
export async function getPublicProperty(slug: string) {
  const property = await resolveEnabledProperty(slug);

  // Read the (empty) rooms inside the resolved tenant's scope.
  const rooms = await runWithTenant({ tenantId: property.tenantId }, () =>
    prisma.room.findMany({
      where: { propertyId: property.id, status: 'empty' },
      select: {
        id: true,
        roomNumber: true,
        roomType: true,
        basePrice: true,
        facilities: true,
        photos: true,
      },
      orderBy: { roomNumber: 'asc' },
    }),
  );

  const prices = rooms.map((r) => Number(r.basePrice));
  const priceRange =
    prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null;

  // White-label branding (PRD Modul 23): the public page renders BRANDED ONLY for a PREMIUM tenant,
  // so non-Premium public pages stay default (`branding: null`). Read via the raw client (no tenant
  // context here) but expose ONLY marketing-safe branding fields (name/color/logoUrl) — never the
  // plan, ids, or any other tenant data.
  const tenant = await rawPrisma.tenant.findUnique({
    where: { id: property.tenantId },
    select: {
      subscriptionPlan: true,
      name: true,
      brandName: true,
      brandColor: true,
      logoKey: true,
    },
  });
  // buildBrandingPayload presigns the logo via the tenant-guarded client, so run it INSIDE the
  // resolved tenant's scope (same pattern as the room read above) so the logo file lookup is scoped.
  const branding =
    tenant && featuresForPlan(tenant.subscriptionPlan).whiteLabel
      ? await runWithTenant({ tenantId: property.tenantId }, () => buildBrandingPayload(tenant))
      : null;

  return {
    branding,
    property: {
      name: property.name,
      type: property.type,
      address: property.address,
      city: property.city,
      province: property.province,
      facilities: property.facilities,
      publicSlug: slug,
    },
    availableRooms: rooms.map((r) => ({
      id: r.id,
      roomNumber: r.roomNumber,
      roomType: r.roomType,
      basePrice: dec(r.basePrice),
      facilities: r.facilities,
      photos: r.photos,
    })),
    availableRoomCount: rooms.length,
    priceRange,
  };
}

/**
 * Create a PUBLIC booking submission (PRD §6.13). Resolves tenant+property from the slug, then
 * inside the tenant scope:
 *   - if `roomId` given → it MUST belong to this property AND be `empty` (else 404/409); on success
 *     the room is reserved (→ `booking`), guarded against double-booking by the partial unique index;
 *   - if no `roomId` → a room-less inquiry lead is created (no room reserved).
 * Always: status `pending`, feeStatus `unpaid`, source `public`, feeDueAt = now + 48h, no fee amount.
 * Emits a `booking_new` in-app notification. Returns a MINIMAL confirmation (a reference only — no
 * internal ids beyond the booking id, and never any other booking's data).
 */
export async function createPublicBooking(slug: string, input: PublicBookingInput) {
  const property = await resolveEnabledProperty(slug);

  return runWithTenant({ tenantId: property.tenantId }, async () => {
    let roomNumberForMsg: string | null = null;

    // Validate the room (if supplied) belongs to THIS property and is bookable.
    if (input.roomId) {
      const room = await prisma.room.findFirst({
        where: { id: input.roomId, propertyId: property.id },
      });
      if (!room) throw Errors.notFound('Room not found');
      if (room.status !== 'empty') {
        throw Errors.conflict('That room is no longer available');
      }
      const existingActive = await prisma.booking.findFirst({
        where: { roomId: input.roomId, status: { in: ['pending', 'confirmed'] } },
      });
      if (existingActive) throw Errors.conflict('That room is no longer available');
      roomNumberForMsg = room.roomNumber;
    }

    const feeDueAt = new Date(Date.now() + PUBLIC_FEE_WINDOW_MS);

    let bookingId: string;
    try {
      bookingId = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({
          data: {
            tenantId: property.tenantId,
            propertyId: property.id,
            roomId: input.roomId ?? null,
            prospectName: input.prospectName,
            prospectPhone: input.prospectPhone,
            prospectEmail: input.prospectEmail,
            plannedCheckInDate: new Date(input.plannedCheckInDate),
            bookingFeeAmount: 0,
            bookingFeeMethod: 'transfer',
            feeStatus: 'unpaid',
            feeDueAt,
            status: 'pending',
            source: 'public',
            message: input.message,
            // recordedByUserId intentionally null — submitted by the public, not a staff user.
          },
        });
        // Reserve the room only when one was chosen.
        if (input.roomId) {
          await tx.room.update({ where: { id: input.roomId }, data: { status: 'booking' } });
        }
        return booking.id;
      });
    } catch (e) {
      // Partial unique index race (another active booking won the room) → conflict.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.conflict('That room is no longer available');
      }
      throw e;
    }

    // Best-effort booking_new notification (PRD §6.18) → owner/manager/admin. Never throws.
    await notify({
      tenantId: property.tenantId,
      type: 'booking_new',
      title: 'Booking publik baru',
      body: roomNumberForMsg
        ? `Booking publik dari ${input.prospectName} untuk kamar ${roomNumberForMsg}.`
        : `Pertanyaan booking publik dari ${input.prospectName}.`,
      link: '/bookings',
      entityType: 'booking',
      entityId: bookingId,
    });

    // Minimal confirmation — a short uppercase reference + the property name. No other data.
    return {
      reference: bookingId.slice(0, 8).toUpperCase(),
      status: 'pending' as const,
      propertyName: property.name,
      message: 'Permintaan booking Anda telah diterima. Pengelola akan segera menghubungi Anda.',
    };
  });
}

/** Release the raw client (used by test teardown). */
export async function disconnectPublic(): Promise<void> {
  await rawPrisma.$disconnect();
}
