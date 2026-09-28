-- Plans as they exist at a payment provider.
--
-- Our own tier and price live in the code catalog, but a provider plan id has
-- to be stored somewhere. A plan an operator created on the provider's
-- dashboard by hand is just as real as one created by code, so the mapping is
-- data rather than configuration, survives a deploy, and can be read during
-- support without reading source.
--
-- This table is global, not per workspace: a plan belongs to the catalogue,
-- not to a customer.
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE "BillingCurrency" AS ENUM ('USD', 'INR');

CREATE TABLE "billing_plan" (
    "id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "tier" "PlanTier" NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "currency" "BillingCurrency" NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "providerPlanId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_plan_pkey" PRIMARY KEY ("id")
);

-- One provider plan per tier, interval and currency. Without this, two rows
-- could claim the same tier and checkout would become ambiguous about which
-- price a customer is being charged.
CREATE UNIQUE INDEX "billing_plan_provider_tier_interval_currency_key"
    ON "billing_plan"("provider", "tier", "interval", "currency");
CREATE INDEX "billing_plan_provider_active_idx" ON "billing_plan"("provider", "active");
