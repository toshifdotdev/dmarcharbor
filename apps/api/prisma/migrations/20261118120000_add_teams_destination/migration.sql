-- Microsoft Teams as a second chat destination, independent of Slack.
CREATE TABLE "teams_destination" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channelLabel" TEXT,
    "encryptedWebhookUrl" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastDeliveredAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_destination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "teams_destination_organizationId_key" ON "teams_destination"("organizationId");
CREATE INDEX "teams_destination_enabled_idx" ON "teams_destination"("enabled");

ALTER TABLE "teams_destination" ADD CONSTRAINT "teams_destination_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
