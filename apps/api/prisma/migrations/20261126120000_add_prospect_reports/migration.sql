-- CreateTable
CREATE TABLE "prospect_report" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT,
    "domain" TEXT NOT NULL,
    "prospectName" TEXT,
    "note" TEXT,
    "contactEmail" TEXT,
    "token" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prospect_report_token_key" ON "prospect_report"("token");

-- CreateIndex
CREATE INDEX "prospect_report_organizationId_createdAt_idx" ON "prospect_report"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "prospect_report" ADD CONSTRAINT "prospect_report_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_report" ADD CONSTRAINT "prospect_report_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
