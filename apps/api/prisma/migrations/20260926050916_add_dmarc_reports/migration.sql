-- CreateEnum
CREATE TYPE "DmarcReportType" AS ENUM ('AGGREGATE', 'FORENSIC');

-- CreateEnum
CREATE TYPE "DmarcAuthType" AS ENUM ('DKIM', 'SPF');

-- CreateTable
CREATE TABLE "dmarc_report" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "reportType" "DmarcReportType" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reportId" TEXT,
    "reportingOrganization" TEXT,
    "reportingEmail" TEXT,
    "extraContactInfo" TEXT,
    "dateRangeBegin" TIMESTAMP(3),
    "dateRangeEnd" TIMESTAMP(3),
    "policyDomain" TEXT,
    "policyAdkim" TEXT,
    "policyAspf" TEXT,
    "policyP" TEXT,
    "policySp" TEXT,
    "policyFraction" INTEGER,
    "reportError" TEXT,
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dmarc_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dmarc_report_record" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "sourceIp" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "disposition" TEXT,
    "dkimResult" TEXT,
    "spfResult" TEXT,
    "headerFrom" TEXT,
    "envelopeFrom" TEXT,
    "policyReason" TEXT,

    CONSTRAINT "dmarc_report_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dmarc_auth_result" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "type" "DmarcAuthType" NOT NULL,
    "domain" TEXT,
    "selector" TEXT,
    "scope" TEXT,
    "result" TEXT NOT NULL,

    CONSTRAINT "dmarc_auth_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dmarc_report_fingerprint_key" ON "dmarc_report"("fingerprint");

-- CreateIndex
CREATE INDEX "dmarc_report_domainId_receivedAt_idx" ON "dmarc_report"("domainId", "receivedAt");

-- CreateIndex
CREATE INDEX "dmarc_report_reportType_receivedAt_idx" ON "dmarc_report"("reportType", "receivedAt");

-- CreateIndex
CREATE INDEX "dmarc_report_record_reportId_idx" ON "dmarc_report_record"("reportId");

-- CreateIndex
CREATE INDEX "dmarc_report_record_sourceIp_idx" ON "dmarc_report_record"("sourceIp");

-- CreateIndex
CREATE INDEX "dmarc_auth_result_recordId_idx" ON "dmarc_auth_result"("recordId");

-- AddForeignKey
ALTER TABLE "dmarc_report" ADD CONSTRAINT "dmarc_report_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dmarc_report_record" ADD CONSTRAINT "dmarc_report_record_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "dmarc_report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dmarc_auth_result" ADD CONSTRAINT "dmarc_auth_result_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "dmarc_report_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;
