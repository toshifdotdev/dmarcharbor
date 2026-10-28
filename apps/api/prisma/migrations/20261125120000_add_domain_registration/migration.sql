-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "domainRegistrationId" TEXT;

-- CreateTable
CREATE TABLE "domain_registration" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "registrableDomain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "registrar" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "warnedThreshold" INTEGER,
    "warnedForExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_registration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "domain_registration_domainId_key" ON "domain_registration"("domainId");

-- CreateIndex
CREATE INDEX "domain_registration_checkedAt_idx" ON "domain_registration"("checkedAt");

-- CreateIndex
CREATE INDEX "domain_registration_expiresAt_idx" ON "domain_registration"("expiresAt");

-- CreateIndex
CREATE INDEX "notification_domainRegistrationId_idx" ON "notification"("domainRegistrationId");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_domainRegistrationId_fkey" FOREIGN KEY ("domainRegistrationId") REFERENCES "domain_registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_registration" ADD CONSTRAINT "domain_registration_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
