-- CreateEnum
CREATE TYPE "ScanRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "scan" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "requestedById" TEXT,
    "status" "ScanRunStatus" NOT NULL DEFAULT 'RUNNING',
    "score" INTEGER,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_domainId_startedAt_idx" ON "scan"("domainId", "startedAt");

-- CreateIndex
CREATE INDEX "scan_requestedById_idx" ON "scan"("requestedById");

-- CreateIndex
CREATE INDEX "scan_status_idx" ON "scan"("status");

-- AddForeignKey
ALTER TABLE "scan" ADD CONSTRAINT "scan_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan" ADD CONSTRAINT "scan_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
