-- CreateEnum
CREATE TYPE "PsaProvider" AS ENUM ('HALOPSA', 'CONNECTWISE', 'AUTOTASK');

-- CreateEnum
CREATE TYPE "PsaConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "PsaTicketSource" AS ENUM ('ALERT_EVENT', 'DNS_CHANGES');

-- CreateEnum
CREATE TYPE "PsaTicketState" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PsaJobKind" AS ENUM ('OPEN', 'NOTE', 'CLOSE');

-- CreateEnum
CREATE TYPE "PsaJobStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'DONE', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "psa_connection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "PsaProvider" NOT NULL,
    "status" "PsaConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "pausedReason" TEXT,
    "encryptedCredentials" TEXT NOT NULL,
    "credentialHint" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "ticketQueueId" TEXT,
    "ticketTypeId" TEXT,
    "openStatusId" TEXT,
    "closedStatusId" TEXT,
    "priorityId" TEXT,
    "closeOnResolve" BOOLEAN NOT NULL DEFAULT true,
    "ticketOnAlert" BOOLEAN NOT NULL DEFAULT true,
    "ticketOnCriticalDns" BOOLEAN NOT NULL DEFAULT true,
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "psa_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psa_company_mapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "externalCompanyId" TEXT NOT NULL,
    "externalCompanyName" TEXT NOT NULL,
    "mappedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "psa_company_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psa_ticket_link" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "PsaProvider" NOT NULL,
    "source" "PsaTicketSource" NOT NULL,
    "alertEventId" TEXT,
    "domainId" TEXT,
    "dnsChangeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalTicketId" TEXT NOT NULL,
    "externalTicketUrl" TEXT,
    "reference" TEXT NOT NULL,
    "state" "PsaTicketState" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "psa_ticket_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psa_ticket_job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" "PsaJobKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "linkReference" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PsaJobStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "psa_ticket_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "psa_connection_organizationId_key" ON "psa_connection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "psa_company_mapping_clientId_key" ON "psa_company_mapping"("clientId");

-- CreateIndex
CREATE INDEX "psa_company_mapping_organizationId_idx" ON "psa_company_mapping"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "psa_ticket_link_alertEventId_key" ON "psa_ticket_link"("alertEventId");

-- CreateIndex
CREATE UNIQUE INDEX "psa_ticket_link_reference_key" ON "psa_ticket_link"("reference");

-- CreateIndex
CREATE INDEX "psa_ticket_link_organizationId_idx" ON "psa_ticket_link"("organizationId");

-- CreateIndex
CREATE INDEX "psa_ticket_link_domainId_idx" ON "psa_ticket_link"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "psa_ticket_job_dedupeKey_key" ON "psa_ticket_job"("dedupeKey");

-- CreateIndex
CREATE INDEX "psa_ticket_job_status_nextAttemptAt_createdAt_idx" ON "psa_ticket_job"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "psa_ticket_job_organizationId_createdAt_idx" ON "psa_ticket_job"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "psa_connection" ADD CONSTRAINT "psa_connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_company_mapping" ADD CONSTRAINT "psa_company_mapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_company_mapping" ADD CONSTRAINT "psa_company_mapping_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_ticket_link" ADD CONSTRAINT "psa_ticket_link_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_ticket_link" ADD CONSTRAINT "psa_ticket_link_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "psa_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_ticket_link" ADD CONSTRAINT "psa_ticket_link_alertEventId_fkey" FOREIGN KEY ("alertEventId") REFERENCES "alert_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_ticket_link" ADD CONSTRAINT "psa_ticket_link_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_ticket_job" ADD CONSTRAINT "psa_ticket_job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_ticket_job" ADD CONSTRAINT "psa_ticket_job_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "psa_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
