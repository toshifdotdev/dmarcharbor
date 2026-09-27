-- CreateEnum
CREATE TYPE "ExportScope" AS ENUM ('ORGANIZATION', 'CLIENT', 'DOMAIN');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('JSON', 'CSV');

-- CreateEnum
CREATE TYPE "ExportState" AS ENUM ('READY', 'REVOKED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'EXPORT_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'EXPORT_DOWNLOADED';
ALTER TYPE "AuditAction" ADD VALUE 'EXPORT_REVOKED';

-- CreateTable
CREATE TABLE "export_job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "scope" "ExportScope" NOT NULL DEFAULT 'ORGANIZATION',
    "targetId" TEXT,
    "scopeLabel" TEXT NOT NULL,
    "format" "ExportFormat" NOT NULL DEFAULT 'JSON',
    "state" "ExportState" NOT NULL DEFAULT 'READY',
    "downloadTokenHash" TEXT,
    "downloadExpiresAt" TIMESTAMP(3),
    "downloadedAt" TIMESTAMP(3),
    "redactions" JSONB,
    "purgeAfter" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "export_job_downloadTokenHash_key" ON "export_job"("downloadTokenHash");

-- CreateIndex
CREATE INDEX "export_job_organizationId_createdAt_idx" ON "export_job"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "export_job_state_purgeAfter_idx" ON "export_job"("state", "purgeAfter");

-- AddForeignKey
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
