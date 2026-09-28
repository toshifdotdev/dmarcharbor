-- How far through payment recovery a subscription has got.
--
-- Without this, a withdrawn subscription kept matching the PAST_DUE filter.
-- Withdrawing left the status as PAST_DUE and never advanced currentPeriodEnd,
-- so the period stayed in the past, the grace check stayed passed, and the
-- customer was warned and emailed again on every daily run, indefinitely. That
-- was true on a single instance and had nothing to do with autoscaling, but it
-- was customer visible either way.
--
-- Recording the step makes each of warn and withdraw happen exactly once, and
-- WITHDRAWN is terminal so the row leaves the recovery query altogether.
CREATE TYPE "DunningStage" AS ENUM ('NONE', 'WARNED', 'WITHDRAWN');

-- Existing rows have already been through dunning if they are PAST_DUE, so
-- defaulting them to WARNED stops a deploy from re-warning every one of them.
ALTER TABLE "subscription" ADD COLUMN "dunningStage" "DunningStage" NOT NULL DEFAULT 'NONE';

UPDATE "subscription"
   SET "dunningStage" = 'WARNED'
 WHERE "status" = 'PAST_DUE' AND "dunningStage" = 'NONE';

CREATE INDEX "subscription_status_dunningStage_idx" ON "subscription"("status", "dunningStage");
