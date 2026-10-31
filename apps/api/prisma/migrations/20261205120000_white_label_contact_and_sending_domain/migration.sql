-- AlterTable
-- Expand-only: the agency's published support contact (Reply-To and the
-- "Questions?" line on client mail) and its own sending domain for client mail.
-- Every column is nullable and nothing reads them in the previous release, so
-- it keeps working while this one rolls out. Null means what it meant before:
-- no contact line, no Reply-To, and client mail from the shared address.
ALTER TABLE "organization" ADD COLUMN "brandSupportEmail" TEXT,
ADD COLUMN "brandSupportUrl" TEXT,
ADD COLUMN "sendingDomain" TEXT,
ADD COLUMN "sendingLocalPart" TEXT,
ADD COLUMN "sendingDomainProviderId" TEXT,
ADD COLUMN "sendingDomainStatus" TEXT,
ADD COLUMN "sendingDomainRecords" JSONB,
ADD COLUMN "sendingDomainVerifiedAt" TIMESTAMP(3),
ADD COLUMN "sendingDomainCheckedAt" TIMESTAMP(3);

-- AlterTable
-- A per-message Reply-To, stored like fromHeader so a retry hours later still
-- carries it. Null sends no Reply-To, which is what every row does today.
ALTER TABLE "email_delivery" ADD COLUMN "replyToHeader" TEXT;

-- CreateIndex
-- A sending domain is created in our email provider's account, which holds one
-- entry per domain, so two workspaces cannot both claim one. Every existing row
-- is null, and Postgres does not treat nulls as equal, so this cannot fail.
CREATE UNIQUE INDEX "organization_sendingDomain_key" ON "organization"("sendingDomain");
