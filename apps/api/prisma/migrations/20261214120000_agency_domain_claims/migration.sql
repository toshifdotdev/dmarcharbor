-- Agency custom and sending domains: claims that lapse, and a daily re-check
-- of a verified custom domain's ownership record.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOM_DOMAIN_UNVERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'AGENCY_DOMAIN_SIGN_IN_REFUSED';

-- AlterTable
ALTER TABLE "organization" ADD COLUMN "customDomainClaimedAt" TIMESTAMP(3),
ADD COLUMN "customDomainRecheckedAt" TIMESTAMP(3),
ADD COLUMN "customDomainFailedChecks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sendingDomainClaimedAt" TIMESTAMP(3);
