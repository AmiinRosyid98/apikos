-- CreateEnum
CREATE TYPE "PaymentGatewayProvider" AS ENUM ('stub', 'midtrans');

-- CreateEnum
CREATE TYPE "PaymentGatewayMethod" AS ENUM ('qris', 'va_bca', 'va_bni', 'va_bri', 'va_mandiri', 'va_permata', 'gopay', 'ovo', 'dana', 'shopeepay', 'linkaja');

-- CreateEnum
CREATE TYPE "PaymentGatewayStatus" AS ENUM ('pending', 'paid', 'expired', 'failed');

-- CreateTable
CREATE TABLE "payment_gateway_txns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "payment_id" UUID,
    "provider" "PaymentGatewayProvider" NOT NULL DEFAULT 'stub',
    "method" "PaymentGatewayMethod" NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "PaymentGatewayStatus" NOT NULL DEFAULT 'pending',
    "instructions" JSONB,
    "paid_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_gateway_txns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_txns_payment_id_key" ON "payment_gateway_txns"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_txns_provider_ref_key" ON "payment_gateway_txns"("provider_ref");

-- CreateIndex
CREATE INDEX "payment_gateway_txns_tenant_id_invoice_id_idx" ON "payment_gateway_txns"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payment_gateway_txns_tenant_id_idx" ON "payment_gateway_txns"("tenant_id");

-- CreateIndex
CREATE INDEX "payment_gateway_txns_status_idx" ON "payment_gateway_txns"("status");

-- AddForeignKey
ALTER TABLE "payment_gateway_txns" ADD CONSTRAINT "payment_gateway_txns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_gateway_txns" ADD CONSTRAINT "payment_gateway_txns_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_gateway_txns" ADD CONSTRAINT "payment_gateway_txns_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
