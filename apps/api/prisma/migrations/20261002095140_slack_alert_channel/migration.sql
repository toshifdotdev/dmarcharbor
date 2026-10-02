-- AlterEnum
ALTER TYPE "AlertChannel" ADD VALUE 'SLACK';

-- DropIndex
DROP INDEX "domain_status_recheckedAt_idx";

-- DropIndex
DROP INDEX "erasure_request_state_claimedAt_idx";

-- DropIndex
DROP INDEX "report_inbox_enabled_pollClaimedAt_idx";

-- DropIndex
DROP INDEX "sso_auth_request_createdAt_idx";

-- DropIndex
DROP INDEX "subscription_status_dunningStage_idx";

-- AlterTable
ALTER TABLE "sso_connection" ALTER COLUMN "clientId" DROP DEFAULT;

-- CreateTable
CREATE TABLE "slack_destination" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channelLabel" TEXT,
    "encryptedWebhookUrl" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deliveryClaimedAt" TIMESTAMP(3),
    "lastDeliveredAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_destination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_destination_organizationId_key" ON "slack_destination"("organizationId");

-- CreateIndex
CREATE INDEX "slack_destination_enabled_idx" ON "slack_destination"("enabled");

-- AddForeignKey
ALTER TABLE "slack_destination" ADD CONSTRAINT "slack_destination_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "compliance_pack_client_idx" RENAME TO "compliance_pack_clientId_idx";

-- RenameIndex
ALTER INDEX "compliance_pack_hash_key" RENAME TO "compliance_pack_pdfHash_key";

-- RenameIndex
ALTER INDEX "compliance_pack_organization_idx" RENAME TO "compliance_pack_organizationId_idx";

-- RenameIndex
ALTER INDEX "organization_custom_domain_key" RENAME TO "organization_customDomain_key";

-- RenameIndex
ALTER INDEX "webhook_delivery_status_nextAttemptAt_idx" RENAME TO "webhook_delivery_status_nextAttemptAt_createdAt_idx";
