-- CreateTable
CREATE TABLE "tls_report" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reportIdentity" TEXT,
    "reportId" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "contactInfo" TEXT,
    "policyDomain" TEXT NOT NULL,
    "dateRangeBegin" TIMESTAMP(3) NOT NULL,
    "dateRangeEnd" TIMESTAMP(3) NOT NULL,
    "successfulSessions" BIGINT NOT NULL,
    "failedSessions" BIGINT NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retentionExpiresAt" TIMESTAMP(3),

    CONSTRAINT "tls_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tls_report_policy" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "policyType" TEXT NOT NULL,
    "policyString" TEXT,
    "mxHost" TEXT,
    "successfulSessions" BIGINT NOT NULL,
    "failedSessions" BIGINT NOT NULL,

    CONSTRAINT "tls_report_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tls_report_failure" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "resultType" TEXT NOT NULL,
    "sendingMtaIp" TEXT,
    "receivingMxHostname" TEXT,
    "receivingMxHelo" TEXT,
    "receivingIp" TEXT,
    "failedSessions" BIGINT NOT NULL,
    "additionalInformation" TEXT,
    "failureReasonCode" TEXT,

    CONSTRAINT "tls_report_failure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tls_report_fingerprint_key" ON "tls_report"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "tls_report_reportIdentity_key" ON "tls_report"("reportIdentity");

-- CreateIndex
CREATE INDEX "tls_report_domainId_dateRangeBegin_idx" ON "tls_report"("domainId", "dateRangeBegin");

-- CreateIndex
CREATE INDEX "tls_report_domainId_receivedAt_idx" ON "tls_report"("domainId", "receivedAt");

-- CreateIndex
CREATE INDEX "tls_report_retentionExpiresAt_idx" ON "tls_report"("retentionExpiresAt");

-- CreateIndex
CREATE INDEX "tls_report_policy_reportId_idx" ON "tls_report_policy"("reportId");

-- CreateIndex
CREATE INDEX "tls_report_failure_policyId_idx" ON "tls_report_failure"("policyId");

-- AddForeignKey
ALTER TABLE "tls_report" ADD CONSTRAINT "tls_report_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tls_report_policy" ADD CONSTRAINT "tls_report_policy_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "tls_report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tls_report_failure" ADD CONSTRAINT "tls_report_failure_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "tls_report_policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
