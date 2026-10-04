-- A reference a customer can actually quote.
--
-- Backfilled from the row id so every already-issued pack still resolves: the
-- public verify endpoint resolved rows by id, and a reader holding one of those
-- documents was told to quote a different value entirely.
--
-- Nullable first, backfilled, then tightened. A NOT NULL unique column cannot be
-- added while rows exist, and the backfill has to run before the constraint.

ALTER TABLE "compliance_pack" ADD COLUMN "reference" TEXT;

UPDATE "compliance_pack" SET "reference" = "id";

CREATE UNIQUE INDEX "compliance_pack_reference_key" ON "compliance_pack"("reference");

ALTER TABLE "compliance_pack" ALTER COLUMN "reference" SET NOT NULL;