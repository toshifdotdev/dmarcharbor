-- Semantic report identity, and the report inbox.
--
-- DmarcReport.fingerprint is a hash of the raw XML, so it identifies the exact
-- bytes received. That is not the same thing as identifying the report: a single
-- report can arrive both as a DNS published URL and as an emailed attachment,
-- and the two copies routinely differ in whitespace, attribute order or gzip
-- settings. Deduplicating on content alone therefore stores the same report
-- twice and doubles the reported volume, which is worse than missing it because
-- a customer who notices inflated numbers stops trusting the numbers that are
-- correct.
--
-- reportIdentity hashes what the report says about itself instead: reporting
-- organisation, report id and date range. Nullable and unique, so historical rows
-- that predate it keep deduplicating on content and new rows get the stronger
-- check.
--
-- The inbox is the one shared mailbox that receives emailed reports. Passwords are
-- stored encrypted, and the last seen UID lets each poll resume rather than
-- refetching the whole mailbox.
ALTER TABLE "dmarc_report" ADD COLUMN "reportIdentity" TEXT;
CREATE UNIQUE INDEX "dmarc_report_reportIdentity_key" ON "dmarc_report"("reportIdentity");

CREATE TABLE "report_inbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 993,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "lastUid" BIGINT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_inbox_pkey" PRIMARY KEY ("id")
);

-- One mailbox per workspace. Two would make "which mailbox does this report
-- belong to" ambiguous, and the product only needs one shared address.
CREATE UNIQUE INDEX "report_inbox_organizationId_key" ON "report_inbox"("organizationId");
CREATE INDEX "report_inbox_enabled_idx" ON "report_inbox"("enabled");

ALTER TABLE "report_inbox"
    ADD CONSTRAINT "report_inbox_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
