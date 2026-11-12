-- Razorpay Recurring Payments (INR): the saved mandate on the subscription, and
-- a record of every charge we schedule on it. Additive only; every new
-- subscription column is nullable or defaulted.

-- AlterTable
ALTER TABLE "subscription" ADD COLUMN "billingInterval" "BillingInterval";
ALTER TABLE "subscription" ADD COLUMN "mandateTokenId" TEXT;
ALTER TABLE "subscription" ADD COLUMN "mandateMethod" TEXT;
ALTER TABLE "subscription" ADD COLUMN "mandateMaxMinor" INTEGER;
ALTER TABLE "subscription" ADD COLUMN "mandateStatus" TEXT;
ALTER TABLE "subscription" ADD COLUMN "carryOverMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "billing_charge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionKey" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'TOKEN',
    "providerOrderId" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "providerInvoiceId" TEXT,
    "paymentUrl" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" "BillingCurrency" NOT NULL,
    "plan" "PlanTier" NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_charge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_charge_providerOrderId_key" ON "billing_charge"("providerOrderId");
CREATE UNIQUE INDEX "billing_charge_subscriptionKey_kind_periodStart_attempt_key" ON "billing_charge"("subscriptionKey", "kind", "periodStart", "attempt");
CREATE INDEX "billing_charge_organizationId_createdAt_idx" ON "billing_charge"("organizationId", "createdAt");
CREATE INDEX "billing_charge_status_idx" ON "billing_charge"("status");

-- AddForeignKey
ALTER TABLE "billing_charge" ADD CONSTRAINT "billing_charge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
