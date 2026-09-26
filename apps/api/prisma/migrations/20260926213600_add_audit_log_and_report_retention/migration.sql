-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('FORENSIC_IDENTITY_ENABLED', 'FORENSIC_IDENTITY_DISABLED', 'FORENSIC_PURGE_SINGLE', 'FORENSIC_PURGE_DOMAIN', 'REPORT_SHARE_CREATED', 'REPORT_SHARE_REVOKED', 'REPORT_DIGEST_CREATED', 'REPORT_DIGEST_UPDATED', 'REPORT_DIGEST_DELETED', 'ALERT_RULE_CREATED', 'ALERT_RULE_UPDATED', 'ALERT_RULE_DELETED', 'ALERT_ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED');

-- AlterTable
ALTER TABLE "dmarc_report" ADD COLUMN     "retentionExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "domainId" TEXT,
    "actorUserId" TEXT,
    "action" "AuditAction" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "detail" JSONB,
    "ipAddress" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_organizationId_createdAt_idx" ON "audit_log"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_domainId_createdAt_idx" ON "audit_log"("domainId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_action_createdAt_idx" ON "audit_log"("action", "createdAt");

-- CreateIndex
CREATE INDEX "dmarc_report_retentionExpiresAt_idx" ON "dmarc_report"("retentionExpiresAt");

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
