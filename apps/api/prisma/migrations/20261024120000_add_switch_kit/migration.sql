-- A per-client report address and the state of switching a domain from another
-- DMARC provider.
--
-- The token is not a secret. It is published in DNS and its only jobs are to
-- identify the client in a report address and to let the DMARC record itself
-- prove domain ownership. The volatile default gives every existing row its own
-- value in one statement, rather than one shared value that would make one
-- client's record verify another's domain.
ALTER TABLE "client" ADD COLUMN "reportToken" TEXT NOT NULL DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 12);
CREATE UNIQUE INDEX "client_reportToken_key" ON "client"("reportToken");

CREATE TYPE "DomainSwitchStatus" AS ENUM ('PLANNED', 'DUAL_REPORTING', 'CUT_OVER');

CREATE TABLE "domain_switch" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "DomainSwitchStatus" NOT NULL DEFAULT 'PLANNED',
    "incumbentVendor" TEXT NOT NULL,
    "incumbentLabel" TEXT NOT NULL,
    "incumbentAggregateTargets" JSONB NOT NULL,
    "incumbentForensicTargets" JSONB NOT NULL,
    "originalRecord" TEXT NOT NULL,
    "plannedRecord" TEXT NOT NULL,
    "lastSeenRecord" TEXT,
    "externalAuthorization" TEXT,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3),
    "cutOverAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_switch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "domain_switch_domainId_key" ON "domain_switch"("domainId");
CREATE INDEX "domain_switch_organizationId_status_idx" ON "domain_switch"("organizationId", "status");

ALTER TABLE "domain_switch" ADD CONSTRAINT "domain_switch_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "domain_switch" ADD CONSTRAINT "domain_switch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "domain_switch" ADD CONSTRAINT "domain_switch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The overlap view reads every aggregate report for one domain since dual
-- reporting began, ordered by the reporting period.
CREATE INDEX "dmarc_report_domainId_dateRangeBegin_idx" ON "dmarc_report"("domainId", "dateRangeBegin");
