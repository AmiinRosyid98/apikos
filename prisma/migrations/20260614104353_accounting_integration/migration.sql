-- CreateEnum
CREATE TYPE "AccountingEntityType" AS ENUM ('payment', 'expense');

-- CreateEnum
CREATE TYPE "AccountingEntryType" AS ENUM ('income', 'expense');

-- CreateEnum
CREATE TYPE "AccountingSyncStatus" AS ENUM ('pending', 'synced', 'failed');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "accounting_api_key_enc" TEXT,
ADD COLUMN     "accounting_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "accounting_provider" TEXT;

-- CreateTable
CREATE TABLE "accounting_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "entity_type" "AccountingEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "entry_type" "AccountingEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "journal_ref" TEXT,
    "status" "AccountingSyncStatus" NOT NULL DEFAULT 'pending',
    "lines" JSONB NOT NULL,
    "error" TEXT,
    "synced_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_entries_tenant_id_idx" ON "accounting_entries"("tenant_id");

-- CreateIndex
CREATE INDEX "accounting_entries_tenant_id_status_idx" ON "accounting_entries"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_entries_tenant_id_entity_type_entity_id_key" ON "accounting_entries"("tenant_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "accounting_entries" ADD CONSTRAINT "accounting_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
