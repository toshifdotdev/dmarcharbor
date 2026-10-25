-- The quantity a provider bills, and the period it was last synced for.
--
-- Flat plans bill quantity 1. FLEET bills max(75, active domains), measured
-- server side before each period starts. The synced marker is compared with
-- currentPeriodEnd so a rerun inside the same 48 hour window is a no-op.
ALTER TABLE "subscription" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "subscription" ADD COLUMN "quantitySyncedPeriodEnd" TIMESTAMP(3);
