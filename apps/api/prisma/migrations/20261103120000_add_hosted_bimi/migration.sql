-- CreateEnum
CREATE TYPE "HostedBimiStatus" AS ENUM ('PENDING', 'ACTIVE', 'RELEASING', 'RELEASED');

-- CreateEnum
CREATE TYPE "HostedBimiAssetKind" AS ENUM ('LOGO', 'CERTIFICATE');

-- CreateTable
CREATE TABLE "hosted_bimi_record" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "HostedBimiStatus" NOT NULL DEFAULT 'PENDING',
    "providerRecordId" TEXT,
    "previousValue" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "certificateExpiresAt" TIMESTAMP(3),
    "certificateIssuer" TEXT,
    "certificateSubject" TEXT,
    "delegated" BOOLEAN NOT NULL DEFAULT false,
    "delegationCheckedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "releaseRequestedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_bimi_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_bimi_asset" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "kind" "HostedBimiAssetKind" NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "hosted_bimi_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_bimi_change" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "previousLogoSha" TEXT,
    "newLogoSha" TEXT,
    "previousCertSha" TEXT,
    "newCertSha" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_bimi_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_bimi_record_domainId_key" ON "hosted_bimi_record"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_bimi_record_token_key" ON "hosted_bimi_record"("token");

-- CreateIndex
CREATE INDEX "hosted_bimi_record_organizationId_idx" ON "hosted_bimi_record"("organizationId");

-- CreateIndex
CREATE INDEX "hosted_bimi_record_status_idx" ON "hosted_bimi_record"("status");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_bimi_asset_recordId_kind_sha256_key" ON "hosted_bimi_asset"("recordId", "kind", "sha256");

-- CreateIndex
CREATE INDEX "hosted_bimi_asset_recordId_kind_retiredAt_idx" ON "hosted_bimi_asset"("recordId", "kind", "retiredAt");

-- CreateIndex
CREATE INDEX "hosted_bimi_change_recordId_createdAt_idx" ON "hosted_bimi_change"("recordId", "createdAt");

-- AddForeignKey
ALTER TABLE "hosted_bimi_record" ADD CONSTRAINT "hosted_bimi_record_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_bimi_record" ADD CONSTRAINT "hosted_bimi_record_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_bimi_asset" ADD CONSTRAINT "hosted_bimi_asset_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "hosted_bimi_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_bimi_change" ADD CONSTRAINT "hosted_bimi_change_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "hosted_bimi_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;
