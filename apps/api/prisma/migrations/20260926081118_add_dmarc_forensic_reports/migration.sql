-- AlterTable
ALTER TABLE "domain" ADD COLUMN     "collectForensicReports" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dmarcRecord" TEXT;

-- CreateTable
CREATE TABLE "dmarc_forensic_report" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "feedbackType" TEXT NOT NULL,
    "reportedDomain" TEXT NOT NULL,
    "sourceIp" TEXT NOT NULL,
    "sourcePort" INTEGER,
    "disposition" TEXT,
    "deliveryAction" TEXT,
    "deliveryStatus" TEXT,
    "dkimResult" TEXT,
    "spfResult" TEXT,
    "authResults" JSONB,
    "reportingMta" TEXT,
    "dsnGateway" TEXT,
    "remoteMta" TEXT,
    "userAgent" TEXT,
    "diagnosticCodes" JSONB,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "recipientPseudonyms" JSONB,
    "envelopeFromPseudonym" TEXT,
    "messageIdPseudonym" TEXT,
    "subjectPseudonym" TEXT,
    "originalMessageDate" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "hasOriginalHeaders" BOOLEAN NOT NULL DEFAULT false,
    "hasOriginalMessageIncluded" BOOLEAN NOT NULL DEFAULT false,
    "redactionVersion" INTEGER NOT NULL,
    "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dmarc_forensic_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dmarc_forensic_report_fingerprint_key" ON "dmarc_forensic_report"("fingerprint");

-- CreateIndex
CREATE INDEX "dmarc_forensic_report_domainId_receivedAt_idx" ON "dmarc_forensic_report"("domainId", "receivedAt");

-- CreateIndex
CREATE INDEX "dmarc_forensic_report_retentionExpiresAt_idx" ON "dmarc_forensic_report"("retentionExpiresAt");

-- CreateIndex
CREATE INDEX "dmarc_forensic_report_reportedDomain_idx" ON "dmarc_forensic_report"("reportedDomain");

-- CreateIndex
CREATE INDEX "dmarc_forensic_report_sourceIp_idx" ON "dmarc_forensic_report"("sourceIp");

-- AddForeignKey
ALTER TABLE "dmarc_forensic_report" ADD CONSTRAINT "dmarc_forensic_report_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
