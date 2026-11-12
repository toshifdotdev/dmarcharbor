-- The part of a renewal charge that pays an upgrade's carried difference, so
-- the subscription's carry-over is cleared only when that charge is captured.
-- Additive, defaulted.
ALTER TABLE "billing_charge" ADD COLUMN "carryOverMinor" INTEGER NOT NULL DEFAULT 0;
