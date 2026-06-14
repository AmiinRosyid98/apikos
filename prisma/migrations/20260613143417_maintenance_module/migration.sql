-- CreateEnum
CREATE TYPE "MaintenancePriority" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('open', 'in_progress', 'waiting_parts', 'done', 'cancelled');

-- AlterTable
ALTER TABLE "tenant_counters" ADD COLUMN     "maintenance_seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "maintenance_seq_year" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "skill" TEXT,
    "phone" TEXT,
    "rating" DECIMAL(2,1),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID,
    "ticket_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "priority" "MaintenancePriority" NOT NULL DEFAULT 'medium',
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'open',
    "vendor_id" UUID,
    "photo_keys" JSONB NOT NULL DEFAULT '[]',
    "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reported_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ,
    "expense_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "maintenance_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendors_tenant_id_idx" ON "vendors"("tenant_id");

-- CreateIndex
CREATE INDEX "vendors_tenant_id_skill_idx" ON "vendors"("tenant_id", "skill");

-- CreateIndex
CREATE INDEX "maintenance_tickets_tenant_id_status_idx" ON "maintenance_tickets"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "maintenance_tickets_tenant_id_room_id_idx" ON "maintenance_tickets"("tenant_id", "room_id");

-- CreateIndex
CREATE INDEX "maintenance_tickets_tenant_id_idx" ON "maintenance_tickets"("tenant_id");

-- CreateIndex
CREATE INDEX "maintenance_tickets_vendor_id_idx" ON "maintenance_tickets"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_tickets_tenant_id_ticket_number_key" ON "maintenance_tickets"("tenant_id", "ticket_number");

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
