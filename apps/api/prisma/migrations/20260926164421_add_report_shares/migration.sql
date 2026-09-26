-- CreateTable
CREATE TABLE "report_share" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "createdById" TEXT,
    "includeForensics" BOOLEAN NOT NULL DEFAULT false,
    "includeSources" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_share_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_share_token_key" ON "report_share"("token");

-- CreateIndex
CREATE INDEX "report_share_organizationId_createdAt_idx" ON "report_share"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "report_share_domainId_idx" ON "report_share"("domainId");

-- AddForeignKey
ALTER TABLE "report_share" ADD CONSTRAINT "report_share_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_share" ADD CONSTRAINT "report_share_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_share" ADD CONSTRAINT "report_share_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_share" ADD CONSTRAINT "report_share_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
