-- Each volume band of a per-domain plan is its own provider plan. Existing rows
-- are flat plans or Fleet's first band, which keeps its price, so 0 is right.

-- DropIndex
DROP INDEX "billing_plan_provider_tier_interval_currency_key";

-- AlterTable
ALTER TABLE "billing_plan" ADD COLUMN     "band" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "billing_plan_provider_tier_interval_currency_band_key" ON "billing_plan"("provider", "tier", "interval", "currency", "band");
