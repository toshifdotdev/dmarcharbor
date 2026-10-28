-- CreateEnum
CREATE TYPE "PolicyProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "policyProposalId" TEXT;

-- CreateTable
CREATE TABLE "policy_proposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "createdById" TEXT,
    "fromPolicy" TEXT NOT NULL,
    "fromTesting" BOOLEAN NOT NULL,
    "policy" TEXT NOT NULL,
    "testing" BOOLEAN NOT NULL,
    "np" TEXT,
    "recordValue" TEXT NOT NULL,
    "applyVia" TEXT NOT NULL,
    "note" TEXT,
    "evidence" JSONB NOT NULL,
    "blockers" TEXT[],
    "status" "PolicyProposalStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedByEmail" TEXT,
    "declineReason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "applyError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policy_proposal_domainId_createdAt_idx" ON "policy_proposal"("domainId", "createdAt");

-- CreateIndex
CREATE INDEX "policy_proposal_organizationId_status_idx" ON "policy_proposal"("organizationId", "status");

-- CreateIndex
CREATE INDEX "notification_policyProposalId_idx" ON "notification"("policyProposalId");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_policyProposalId_fkey" FOREIGN KEY ("policyProposalId") REFERENCES "policy_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_proposal" ADD CONSTRAINT "policy_proposal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_proposal" ADD CONSTRAINT "policy_proposal_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_proposal" ADD CONSTRAINT "policy_proposal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_proposal" ADD CONSTRAINT "policy_proposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
