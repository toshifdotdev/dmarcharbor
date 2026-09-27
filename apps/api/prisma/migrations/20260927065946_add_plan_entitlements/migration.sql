-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('NONE', 'RAZORPAY', 'PADDLE');

-- CreateEnum
CREATE TYPE "ErasureScope" AS ENUM ('ORGANIZATION', 'CLIENT', 'DOMAIN');

-- CreateEnum
CREATE TYPE "ErasureState" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PLAN_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'ENTITLEMENT_OVERRIDE_SET';
ALTER TYPE "AuditAction" ADD VALUE 'ENTITLEMENT_OVERRIDE_REMOVED';

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "plan" "PlanTier" NOT NULL DEFAULT 'MOORING';

-- CreateTable
CREATE TABLE "subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL DEFAULT 'MOORING',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "provider" "BillingProvider" NOT NULL DEFAULT 'NONE',
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_override" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entitlement" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erasure_request" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" "ErasureScope" NOT NULL DEFAULT 'ORGANIZATION',
    "targetId" TEXT,
    "requestedById" TEXT NOT NULL,
    "state" "ErasureState" NOT NULL DEFAULT 'PENDING',
    "certificate" JSONB,
    "purgeAfter" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erasure_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_providerSubscriptionId_key" ON "subscription"("providerSubscriptionId");

-- CreateIndex
CREATE INDEX "subscription_provider_idx" ON "subscription"("provider");

-- CreateIndex
CREATE INDEX "subscription_status_idx" ON "subscription"("status");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_organizationId_key" ON "subscription"("organizationId");

-- CreateIndex
CREATE INDEX "entitlement_override_organizationId_entitlement_idx" ON "entitlement_override"("organizationId", "entitlement");

-- CreateIndex
CREATE INDEX "entitlement_override_expiresAt_idx" ON "entitlement_override"("expiresAt");

-- CreateIndex
CREATE INDEX "erasure_request_organizationId_state_idx" ON "erasure_request"("organizationId", "state");

-- CreateIndex
CREATE INDEX "erasure_request_state_purgeAfter_idx" ON "erasure_request"("state", "purgeAfter");

-- CreateIndex
CREATE INDEX "organization_plan_idx" ON "organization"("plan");

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_override" ADD CONSTRAINT "entitlement_override_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erasure_request" ADD CONSTRAINT "erasure_request_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
