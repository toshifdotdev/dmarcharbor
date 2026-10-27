-- CreateEnum
CREATE TYPE "HostedSpfStatus" AS ENUM ('PENDING', 'ACTIVE', 'RELEASING', 'RELEASED');

-- CreateTable
CREATE TABLE "hosted_spf_record" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "HostedSpfStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "sources" JSONB NOT NULL,
    "allQualifier" TEXT NOT NULL,
    "sourceState" JSONB NOT NULL,
    "parts" JSONB NOT NULL,
    "lookupCount" INTEGER NOT NULL,
    "lastFlattenedAt" TIMESTAMP(3),
    "lastFlattenError" TEXT,
    "capacityBlocked" BOOLEAN NOT NULL DEFAULT false,
    "delegated" BOOLEAN NOT NULL DEFAULT false,
    "delegationCheckedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "releaseRequestedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_spf_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_spf_change" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "previousSources" JSONB,
    "newSources" JSONB NOT NULL,
    "previousParts" JSONB,
    "newParts" JSONB NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_spf_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_spf_record_domainId_key" ON "hosted_spf_record"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_spf_record_token_key" ON "hosted_spf_record"("token");

-- CreateIndex
CREATE INDEX "hosted_spf_record_organizationId_idx" ON "hosted_spf_record"("organizationId");

-- CreateIndex
CREATE INDEX "hosted_spf_record_status_idx" ON "hosted_spf_record"("status");

-- CreateIndex
CREATE INDEX "hosted_spf_change_recordId_createdAt_idx" ON "hosted_spf_change"("recordId", "createdAt");

-- AddForeignKey
ALTER TABLE "hosted_spf_record" ADD CONSTRAINT "hosted_spf_record_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_spf_record" ADD CONSTRAINT "hosted_spf_record_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_spf_change" ADD CONSTRAINT "hosted_spf_change_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "hosted_spf_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;
