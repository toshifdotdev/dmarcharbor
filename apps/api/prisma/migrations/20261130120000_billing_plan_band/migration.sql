-- Each volume band of a per-domain plan is its own provider plan. Existing rows
-- are flat plans or Fleet's first band, which keeps its price, so 0 is right.

-- DropIndex
DROP INDEX "billing_plan_provider_tier_interval_currency_key"; -- expand-contract: approved: the old key would refuse Fleet's band rows, so it cannot outlive this release; the previous release reads billing_plan by these columns with a plain WHERE, which works without the index, and writes it only from the operator-run plan sync, which is not run during a deploy


-- AlterTable
ALTER TABLE "billing_plan" ADD COLUMN     "band" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "billing_plan_provider_tier_interval_currency_band_key" ON "billing_plan"("provider", "tier", "interval", "currency", "band");
