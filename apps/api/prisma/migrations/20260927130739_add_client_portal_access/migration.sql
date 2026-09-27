-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PORTAL_ACCESS_GRANTED';
ALTER TYPE "AuditAction" ADD VALUE 'PORTAL_ACCESS_REVOKED';

-- CreateTable
CREATE TABLE "client_portal_access" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "displayName" TEXT,
    "revokedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_portal_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_portal_access_email_idx" ON "client_portal_access"("email");

-- CreateIndex
CREATE INDEX "client_portal_access_userId_idx" ON "client_portal_access"("userId");

-- CreateIndex
CREATE INDEX "client_portal_access_organizationId_revokedAt_idx" ON "client_portal_access"("organizationId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "client_portal_access_clientId_email_key" ON "client_portal_access"("clientId", "email");

-- AddForeignKey
ALTER TABLE "client_portal_access" ADD CONSTRAINT "client_portal_access_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_access" ADD CONSTRAINT "client_portal_access_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_access" ADD CONSTRAINT "client_portal_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
