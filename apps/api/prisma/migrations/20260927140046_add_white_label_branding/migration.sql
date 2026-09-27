-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'BRANDING_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOM_DOMAIN_VERIFIED';

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "brandAccentColor" TEXT,
ADD COLUMN     "brandLogoUrl" TEXT,
ADD COLUMN     "brandPrimaryColor" TEXT,
ADD COLUMN     "customDomain" TEXT,
ADD COLUMN     "customDomainToken" TEXT,
ADD COLUMN     "customDomainVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "organization_customDomain_idx" ON "organization"("customDomain");
