-- Domains beyond the plan's domain limit stop storing new reports until the
-- account is within its plan again. Expand only: two nullable columns and two
-- audit actions.
-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'DOMAIN_MONITORING_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE 'DOMAIN_MONITORING_RESUMED';
-- AlterTable
ALTER TABLE "domain" ADD COLUMN "monitoringPausedAt" TIMESTAMP(3),
ADD COLUMN "monitoringPausedReason" TEXT;
