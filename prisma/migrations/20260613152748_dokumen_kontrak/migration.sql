-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('draft', 'active', 'signed', 'expired', 'terminated');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('ktp', 'sim', 'kk', 'contract', 'other');

-- AlterTable
ALTER TABLE "tenant_counters" ADD COLUMN     "contract_seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "contract_seq_year" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "contract_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID,
    "template_id" UUID,
    "contract_number" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'draft',
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "signed_at" TIMESTAMPTZ,
    "resident_signature_key" TEXT,
    "owner_signature_key" TEXT,
    "notes" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resident_id" UUID,
    "property_id" UUID,
    "type" "DocumentType" NOT NULL DEFAULT 'other',
    "name" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "expires_at" DATE,
    "notes" TEXT,
    "uploaded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_templates_tenant_id_idx" ON "contract_templates"("tenant_id");

-- CreateIndex
CREATE INDEX "contract_templates_tenant_id_property_id_idx" ON "contract_templates"("tenant_id", "property_id");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_idx" ON "contracts"("tenant_id");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_resident_id_idx" ON "contracts"("tenant_id", "resident_id");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_property_id_idx" ON "contracts"("tenant_id", "property_id");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_status_idx" ON "contracts"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_tenant_id_contract_number_key" ON "contracts"("tenant_id", "contract_number");

-- CreateIndex
CREATE INDEX "documents_tenant_id_idx" ON "documents"("tenant_id");

-- CreateIndex
CREATE INDEX "documents_tenant_id_resident_id_idx" ON "documents"("tenant_id", "resident_id");

-- CreateIndex
CREATE INDEX "documents_tenant_id_expires_at_idx" ON "documents"("tenant_id", "expires_at");

-- AddForeignKey
ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
