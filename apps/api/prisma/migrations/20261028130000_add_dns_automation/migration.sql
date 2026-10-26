-- CreateEnum
CREATE TYPE "DnsProvider" AS ENUM ('CLOUDFLARE');

-- CreateEnum
CREATE TYPE "DnsRecordKind" AS ENUM ('VERIFICATION', 'DMARC_SUGGESTED', 'DMARC_POLICY', 'SWITCH_DUAL', 'SWITCH_CUTOVER');

-- CreateTable
CREATE TABLE "dns_provider_connection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "DnsProvider" NOT NULL DEFAULT 'CLOUDFLARE',
    "label" VARCHAR(80),
    "encryptedToken" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "accountName" TEXT,
    "createdById" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dns_provider_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dns_publication" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" "DnsProvider" NOT NULL,
    "zoneId" TEXT NOT NULL,
    "recordName" TEXT NOT NULL,
    "providerRecordId" TEXT NOT NULL,
    "kind" "DnsRecordKind" NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "dns_publication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dns_provider_connection_organizationId_idx" ON "dns_provider_connection"("organizationId");

-- CreateIndex
CREATE INDEX "dns_publication_organizationId_publishedAt_idx" ON "dns_publication"("organizationId", "publishedAt");

-- CreateIndex
CREATE INDEX "dns_publication_domainId_publishedAt_idx" ON "dns_publication"("domainId", "publishedAt");

-- AddForeignKey
ALTER TABLE "dns_provider_connection" ADD CONSTRAINT "dns_provider_connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_provider_connection" ADD CONSTRAINT "dns_provider_connection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_publication" ADD CONSTRAINT "dns_publication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_publication" ADD CONSTRAINT "dns_publication_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_publication" ADD CONSTRAINT "dns_publication_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "dns_provider_connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_publication" ADD CONSTRAINT "dns_publication_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
