-- CreateEnum
CREATE TYPE "HostedDmarcStatus" AS ENUM ('PENDING', 'ACTIVE', 'RELEASING', 'RELEASED');

-- CreateTable
CREATE TABLE "hosted_dmarc_record" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "HostedDmarcStatus" NOT NULL DEFAULT 'PENDING',
    "providerRecordId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "delegated" BOOLEAN NOT NULL DEFAULT false,
    "delegationCheckedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "releaseRequestedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_dmarc_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_dmarc_change" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "readinessOverride" BOOLEAN NOT NULL DEFAULT false,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "hosted_dmarc_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_dmarc_record_domainId_key" ON "hosted_dmarc_record"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_dmarc_record_token_key" ON "hosted_dmarc_record"("token");

-- CreateIndex
CREATE INDEX "hosted_dmarc_record_organizationId_idx" ON "hosted_dmarc_record"("organizationId");

-- CreateIndex
CREATE INDEX "hosted_dmarc_record_status_idx" ON "hosted_dmarc_record"("status");

-- CreateIndex
CREATE INDEX "hosted_dmarc_change_recordId_createdAt_idx" ON "hosted_dmarc_change"("recordId", "createdAt");

-- AddForeignKey
ALTER TABLE "hosted_dmarc_record" ADD CONSTRAINT "hosted_dmarc_record_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_dmarc_record" ADD CONSTRAINT "hosted_dmarc_record_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_dmarc_change" ADD CONSTRAINT "hosted_dmarc_change_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "hosted_dmarc_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;
