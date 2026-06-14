-- Public Landing Page + Public Booking Link (PRD §6.2, §6.13).

-- CreateEnum: how a booking was submitted (internal staff vs public link).
CREATE TYPE "BookingSource" AS ENUM ('internal', 'public');

-- Properties: public marketing/booking gate.
ALTER TABLE "properties" ADD COLUMN     "public_enabled" BOOLEAN NOT NULL DEFAULT false;

-- public_slug already exists as a nullable column; add the UNIQUE constraint so a slug resolves
-- exactly one tenant/property. (No existing duplicates expected — column was unused until now.)
CREATE UNIQUE INDEX "properties_public_slug_key" ON "properties"("public_slug");

-- Bookings: source tag + optional prospect message; room_id becomes nullable (room-less public lead).
ALTER TABLE "bookings" ADD COLUMN     "source" "BookingSource" NOT NULL DEFAULT 'internal';
ALTER TABLE "bookings" ADD COLUMN     "message" TEXT;
ALTER TABLE "bookings" ALTER COLUMN "room_id" DROP NOT NULL;

-- The room FK changes from CASCADE to SET NULL (a deleted room must not delete historical bookings).
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_room_id_fkey";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index the source so the bookings list can filter public leads efficiently.
CREATE INDEX "bookings_source_idx" ON "bookings"("source");
