-- CreateEnum
CREATE TYPE "HostedMtaStsStatus" AS ENUM ('PENDING', 'ACTIVE', 'RELEASING', 'RELEASED');

-- CreateEnum
CREATE TYPE "HostedMtaStsMode" AS ENUM ('testing', 'enforce', 'none');

-- CreateTable
CREATE TABLE "hosted_mta_sts_record" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "HostedMtaStsStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "HostedMtaStsMode" NOT NULL DEFAULT 'testing',
    "mx" TEXT[],
    "maxAge" INTEGER NOT NULL DEFAULT 86400,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "customHostnameId" TEXT,
    "hostnameStatus" TEXT,
    "sslStatus" TEXT,
    "sslError" TEXT,
    "txtRecordId" TEXT,
    "delegated" BOOLEAN NOT NULL DEFAULT false,
    "mtaCnameState" TEXT,
    "txtCnameState" TEXT,
    "delegationCheckedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "uncoveredMx" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uncoveredCheckedAt" TIMESTAMP(3),
    "enforcedAt" TIMESTAMP(3),
    "releaseRequestedAt" TIMESTAMP(3),
    "releaseServeUntil" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "previousTxt" TEXT,
    "previousPolicy" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_mta_sts_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_mta_sts_change" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "previousMode" TEXT,
    "newMode" TEXT NOT NULL,
    "previousMx" TEXT[],
    "newMx" TEXT[],
    "previousMaxAge" INTEGER,
    "newMaxAge" INTEGER NOT NULL,
    "previousPolicyId" TEXT,
    "newPolicyId" TEXT NOT NULL,
    "readinessOverride" BOOLEAN NOT NULL DEFAULT false,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_mta_sts_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_mta_sts_record_domainId_key" ON "hosted_mta_sts_record"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_mta_sts_record_token_key" ON "hosted_mta_sts_record"("token");

-- CreateIndex
CREATE INDEX "hosted_mta_sts_record_organizationId_idx" ON "hosted_mta_sts_record"("organizationId");

-- CreateIndex
CREATE INDEX "hosted_mta_sts_record_status_idx" ON "hosted_mta_sts_record"("status");

-- CreateIndex
CREATE INDEX "hosted_mta_sts_change_recordId_createdAt_idx" ON "hosted_mta_sts_change"("recordId", "createdAt");

-- AddForeignKey
ALTER TABLE "hosted_mta_sts_record" ADD CONSTRAINT "hosted_mta_sts_record_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_mta_sts_record" ADD CONSTRAINT "hosted_mta_sts_record_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_mta_sts_change" ADD CONSTRAINT "hosted_mta_sts_change_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "hosted_mta_sts_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;
