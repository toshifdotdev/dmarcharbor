-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'ERASURE_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'ERASURE_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'ERASURE_COMPLETED';

-- DropForeignKey
ALTER TABLE "erasure_request" DROP CONSTRAINT "erasure_request_organizationId_fkey";

-- AlterTable
ALTER TABLE "erasure_request" ALTER COLUMN "organizationId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "erasure_request_completedAt_idx" ON "erasure_request"("completedAt");
