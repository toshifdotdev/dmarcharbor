-- CreateEnum
CREATE TYPE "IpIntelStatus" AS ENUM ('OK', 'PARTIAL', 'FAILED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "SenderReviewStatus" AS ENUM ('APPROVED', 'NOT_OURS');

-- CreateTable
CREATE TABLE "source_ip_intel" (
    "ip" TEXT NOT NULL,
    "ptr" TEXT,
    "ptrConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "asn" INTEGER,
    "asnName" VARCHAR(120),
    "status" "IpIntelStatus" NOT NULL,
    "lookedUpAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_ip_intel_pkey" PRIMARY KEY ("ip")
);

-- CreateTable
CREATE TABLE "sender_review" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "senderKey" TEXT NOT NULL,
    "status" "SenderReviewStatus",
    "ownerUserId" TEXT,
    "note" VARCHAR(280),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_ip_intel_expiresAt_idx" ON "source_ip_intel"("expiresAt");

-- CreateIndex
CREATE INDEX "source_ip_intel_lastSeenAt_idx" ON "source_ip_intel"("lastSeenAt");

-- CreateIndex
CREATE INDEX "sender_review_organizationId_idx" ON "sender_review"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "sender_review_domainId_senderKey_key" ON "sender_review"("domainId", "senderKey");

-- AddForeignKey
ALTER TABLE "sender_review" ADD CONSTRAINT "sender_review_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_review" ADD CONSTRAINT "sender_review_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_review" ADD CONSTRAINT "sender_review_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_review" ADD CONSTRAINT "sender_review_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

