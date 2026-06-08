-- CreateEnum
CREATE TYPE "DepositMethod" AS ENUM ('cash', 'transfer', 'qris', 'other');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('held', 'partially_refunded', 'refunded', 'forfeited');

-- CreateEnum
CREATE TYPE "HandoverType" AS ENUM ('checkin', 'checkout');

-- CreateTable
CREATE TABLE "deposit_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "DepositMethod" NOT NULL DEFAULT 'cash',
    "received_date" DATE NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'held',
    "refunded_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refunded_date" DATE,
    "deduction_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deduction_notes" TEXT,
    "notes" TEXT,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "deposit_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID,
    "type" "HandoverType" NOT NULL,
    "date" DATE NOT NULL,
    "photo_keys" JSONB NOT NULL DEFAULT '[]',
    "inventory" JSONB NOT NULL DEFAULT '[]',
    "initial_meter_electricity" DECIMAL(14,3),
    "signature_key" TEXT,
    "notes" TEXT,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deposit_records_tenant_id_idx" ON "deposit_records"("tenant_id");

-- CreateIndex
CREATE INDEX "deposit_records_resident_id_idx" ON "deposit_records"("resident_id");

-- CreateIndex
CREATE INDEX "deposit_records_property_id_idx" ON "deposit_records"("property_id");

-- CreateIndex
CREATE INDEX "deposit_records_status_idx" ON "deposit_records"("status");

-- CreateIndex
CREATE INDEX "handover_records_tenant_id_idx" ON "handover_records"("tenant_id");

-- CreateIndex
CREATE INDEX "handover_records_resident_id_idx" ON "handover_records"("resident_id");

-- CreateIndex
CREATE INDEX "handover_records_property_id_idx" ON "handover_records"("property_id");

-- CreateIndex
CREATE INDEX "handover_records_type_idx" ON "handover_records"("type");

-- AddForeignKey
ALTER TABLE "deposit_records" ADD CONSTRAINT "deposit_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_records" ADD CONSTRAINT "deposit_records_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_records" ADD CONSTRAINT "deposit_records_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_records" ADD CONSTRAINT "deposit_records_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_records" ADD CONSTRAINT "handover_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_records" ADD CONSTRAINT "handover_records_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_records" ADD CONSTRAINT "handover_records_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_records" ADD CONSTRAINT "handover_records_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
