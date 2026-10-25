

-- AlterTable
ALTER TABLE "compliance_pack" ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodStart" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "compliance_document_file" (
    "id" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_document_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_report_schedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "dayOfMonth" INTEGER NOT NULL DEFAULT 2,
    "sendHourUtc" INTEGER NOT NULL DEFAULT 9,
    "recipientEmails" TEXT[],
    "lastIssuedPeriod" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_report_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_report_link" (
    "id" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_report_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compliance_document_file_packId_key" ON "compliance_document_file"("packId");

-- CreateIndex
CREATE INDEX "compliance_document_file_expiresAt_idx" ON "compliance_document_file"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_report_schedule_clientId_key" ON "monthly_report_schedule"("clientId");

-- CreateIndex
CREATE INDEX "monthly_report_schedule_enabled_idx" ON "monthly_report_schedule"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_report_link_tokenHash_key" ON "monthly_report_link"("tokenHash");

-- CreateIndex
CREATE INDEX "monthly_report_link_packId_idx" ON "monthly_report_link"("packId");

-- CreateIndex
CREATE INDEX "monthly_report_link_expiresAt_idx" ON "monthly_report_link"("expiresAt");

-- CreateIndex
CREATE INDEX "compliance_pack_clientId_scope_periodStart_idx" ON "compliance_pack"("clientId", "scope", "periodStart");

-- AddForeignKey
ALTER TABLE "compliance_document_file" ADD CONSTRAINT "compliance_document_file_packId_fkey" FOREIGN KEY ("packId") REFERENCES "compliance_pack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_report_schedule" ADD CONSTRAINT "monthly_report_schedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_report_schedule" ADD CONSTRAINT "monthly_report_schedule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_report_link" ADD CONSTRAINT "monthly_report_link_packId_fkey" FOREIGN KEY ("packId") REFERENCES "compliance_pack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

