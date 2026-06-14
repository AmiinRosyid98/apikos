-- CreateEnum
CREATE TYPE "WaTemplateType" AS ENUM ('invoice_new', 'reminder_due', 'reminder_overdue', 'payment_received', 'contract_expiry', 'broadcast', 'custom');

-- CreateEnum
CREATE TYPE "WaMessageStatus" AS ENUM ('queued', 'sent', 'failed', 'stub');

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "reminder_config" JSONB;

-- CreateTable
CREATE TABLE "wa_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID,
    "type" "WaTemplateType" NOT NULL DEFAULT 'custom',
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wa_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID,
    "resident_id" UUID,
    "invoice_id" UUID,
    "to_phone" TEXT NOT NULL,
    "to_name" TEXT,
    "template_type" "WaTemplateType",
    "reminder_key" TEXT,
    "body" TEXT NOT NULL,
    "status" "WaMessageStatus" NOT NULL DEFAULT 'stub',
    "provider" TEXT,
    "provider_message_id" TEXT,
    "error" TEXT,
    "sent_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wa_templates_tenant_id_idx" ON "wa_templates"("tenant_id");

-- CreateIndex
CREATE INDEX "wa_templates_property_id_idx" ON "wa_templates"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_templates_tenant_id_property_id_type_key" ON "wa_templates"("tenant_id", "property_id", "type");

-- CreateIndex
CREATE INDEX "wa_messages_tenant_id_idx" ON "wa_messages"("tenant_id");

-- CreateIndex
CREATE INDEX "wa_messages_property_id_idx" ON "wa_messages"("property_id");

-- CreateIndex
CREATE INDEX "wa_messages_resident_id_idx" ON "wa_messages"("resident_id");

-- CreateIndex
CREATE INDEX "wa_messages_invoice_id_idx" ON "wa_messages"("invoice_id");

-- CreateIndex
CREATE INDEX "wa_messages_status_idx" ON "wa_messages"("status");

-- CreateIndex
CREATE INDEX "wa_messages_created_at_idx" ON "wa_messages"("created_at");

-- AddForeignKey
ALTER TABLE "wa_templates" ADD CONSTRAINT "wa_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_templates" ADD CONSTRAINT "wa_templates_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
