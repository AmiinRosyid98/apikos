-- CreateEnum
CREATE TYPE "MeterType" AS ENUM ('electricity', 'water');

-- CreateTable
CREATE TABLE "meter_readings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "type" "MeterType" NOT NULL DEFAULT 'electricity',
    "period_month" INTEGER NOT NULL,
    "period_year" INTEGER NOT NULL,
    "previous_reading" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "current_reading" DECIMAL(14,3) NOT NULL,
    "usage" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "price_per_unit" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "photo_url" TEXT,
    "photo_key" TEXT NOT NULL,
    "recorded_by_user_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "meter_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meter_readings_tenant_id_idx" ON "meter_readings"("tenant_id");

-- CreateIndex
CREATE INDEX "meter_readings_room_id_idx" ON "meter_readings"("room_id");

-- CreateIndex
CREATE INDEX "meter_readings_property_id_idx" ON "meter_readings"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "meter_readings_tenant_id_room_id_type_period_month_period_y_key" ON "meter_readings"("tenant_id", "room_id", "type", "period_month", "period_year");

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
