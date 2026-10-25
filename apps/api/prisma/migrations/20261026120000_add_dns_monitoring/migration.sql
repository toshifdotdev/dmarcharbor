-- Scheduled DNS monitoring: a trigger on scans, a claim timestamp on domains,
-- and the change history that makes a rescanned record meaningful.
CREATE TYPE "ScanTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

ALTER TABLE "scan" ADD COLUMN "trigger" "ScanTrigger" NOT NULL DEFAULT 'MANUAL';
CREATE INDEX "scan_domainId_trigger_startedAt_idx" ON "scan"("domainId", "trigger", "startedAt");

ALTER TABLE "domain" ADD COLUMN "monitorClaimedAt" TIMESTAMP(3);

CREATE TYPE "DnsChangeKind" AS ENUM ('DMARC_RECORD', 'DMARC_POLICY', 'DMARC_RUA', 'SPF_RECORD', 'SPF_LOOKUPS', 'SPF_ALL', 'DKIM_SELECTOR', 'MX');
CREATE TYPE "DnsChangeSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TABLE "dns_change" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "previousScanId" TEXT,
    "kind" "DnsChangeKind" NOT NULL,
    "severity" "DnsChangeSeverity" NOT NULL,
    "code" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,

    CONSTRAINT "dns_change_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dns_change_domainId_detectedAt_idx" ON "dns_change"("domainId", "detectedAt");
CREATE INDEX "dns_change_organizationId_detectedAt_idx" ON "dns_change"("organizationId", "detectedAt");
CREATE INDEX "dns_change_notifiedAt_severity_idx" ON "dns_change"("notifiedAt", "severity");

ALTER TABLE "dns_change" ADD CONSTRAINT "dns_change_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dns_change" ADD CONSTRAINT "dns_change_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dns_change" ADD CONSTRAINT "dns_change_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dns_change" ADD CONSTRAINT "dns_change_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification" ADD COLUMN "dnsChangeId" TEXT;
CREATE UNIQUE INDEX "notification_dnsChangeId_userId_key" ON "notification"("dnsChangeId", "userId");
ALTER TABLE "notification" ADD CONSTRAINT "notification_dnsChangeId_fkey" FOREIGN KEY ("dnsChangeId") REFERENCES "dns_change"("id") ON DELETE CASCADE ON UPDATE CASCADE;
