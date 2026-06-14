-- CreateEnum
CREATE TYPE "BookingFeeMethod" AS ENUM ('cash', 'transfer', 'qris', 'other');

-- CreateEnum
CREATE TYPE "BookingFeeStatus" AS ENUM ('unpaid', 'paid', 'waived');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('pending', 'confirmed', 'converted', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "prospect_name" TEXT NOT NULL,
    "prospect_phone" TEXT NOT NULL,
    "prospect_email" TEXT,
    "planned_check_in_date" DATE NOT NULL,
    "booking_fee_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "booking_fee_method" "BookingFeeMethod" NOT NULL DEFAULT 'cash',
    "fee_status" "BookingFeeStatus" NOT NULL DEFAULT 'unpaid',
    "fee_due_at" TIMESTAMPTZ NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'pending',
    "converted_resident_id" UUID,
    "notes" TEXT,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bookings_tenant_id_idx" ON "bookings"("tenant_id");

-- CreateIndex
CREATE INDEX "bookings_property_id_idx" ON "bookings"("property_id");

-- CreateIndex
CREATE INDEX "bookings_room_id_idx" ON "bookings"("room_id");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_converted_resident_id_fkey" FOREIGN KEY ("converted_resident_id") REFERENCES "residents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One ACTIVE booking per room (PRD §6.13). Only pending|confirmed count as "active"; a room
-- may have many cancelled/expired/converted bookings historically. Partial unique index — not
-- expressible in the Prisma schema, so applied here as raw SQL. Backs the 409 on duplicate
-- active booking (the service also pre-checks for a friendlier message).
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_active_room_unique"
  ON "bookings" ("room_id")
  WHERE "status" IN ('pending', 'confirmed');
