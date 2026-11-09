-- Agency custom domain hosting (session 14): where the verified hostname is
-- served from, its certificate, and when it first answered through us.
-- Additive only; every column is nullable.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOM_DOMAIN_LIVE';

-- AlterTable
ALTER TABLE "organization" ADD COLUMN "customDomainHostnameId" TEXT;
ALTER TABLE "organization" ADD COLUMN "customDomainHostnameStatus" TEXT;
ALTER TABLE "organization" ADD COLUMN "customDomainSslStatus" TEXT;
ALTER TABLE "organization" ADD COLUMN "customDomainSslError" TEXT;
ALTER TABLE "organization" ADD COLUMN "customDomainCnameState" TEXT;
ALTER TABLE "organization" ADD COLUMN "customDomainCheckedAt" TIMESTAMP(3);
ALTER TABLE "organization" ADD COLUMN "customDomainLiveAt" TIMESTAMP(3);
ALTER TABLE "organization" ADD COLUMN "customDomainOperatorNotifiedAt" TIMESTAMP(3);
ALTER TABLE "organization" ADD COLUMN "customDomainSetupError" TEXT;
