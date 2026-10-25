-- A per-domain plan joins the ladder's catalog.
--
-- In its own migration because Postgres cannot use a new enum value in the
-- transaction that adds it. The existing four tiers are untouched.
ALTER TYPE "PlanTier" ADD VALUE IF NOT EXISTS 'FLEET';
