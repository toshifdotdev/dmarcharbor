-- Recreate the foreign key that the previous migration dropped.
--
-- Dropping the constraint and relaxing NOT NULL was not sufficient on its own.
-- Without the constraint the workspace could be deleted while the erasure
-- request kept pointing at it, which left a dangling reference and then made
-- the audit write fail its foreign key check. The request has to survive the
-- workspace it describes, so the reference is SET NULL rather than cascading.
--
-- Rows whose workspace no longer exists are cleared first, because the window
-- in which the constraint was missing may have left references behind. Those
-- rows are completed erasure records and their certificates are the surviving
-- evidence, so nothing of value is lost.
UPDATE "erasure_request"
SET "organizationId" = NULL
WHERE "organizationId" IS NOT NULL
  AND "organizationId" NOT IN (SELECT "id" FROM "organization");

ALTER TABLE "erasure_request"
ADD CONSTRAINT "erasure_request_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
