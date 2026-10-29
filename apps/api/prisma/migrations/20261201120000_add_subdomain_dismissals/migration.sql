-- CreateTable
CREATE TABLE "subdomain_dismissal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dismissedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subdomain_dismissal_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "subdomain_dismissal_organizationId_idx" ON "subdomain_dismissal"("organizationId");
-- CreateIndex
CREATE UNIQUE INDEX "subdomain_dismissal_domainId_name_key" ON "subdomain_dismissal"("domainId", "name");
-- AddForeignKey
ALTER TABLE "subdomain_dismissal" ADD CONSTRAINT "subdomain_dismissal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "subdomain_dismissal" ADD CONSTRAINT "subdomain_dismissal_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "subdomain_dismissal" ADD CONSTRAINT "subdomain_dismissal_dismissedById_fkey" FOREIGN KEY ("dismissedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
