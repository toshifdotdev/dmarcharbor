-- Billing webhook receipts. Both providers redeliver until acknowledged, often
-- repeatedly and sometimes out of order, so the provider event id is unique and
-- is what stops a transition being applied twice.
CREATE TABLE "billing_event" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "type" TEXT NOT NULL,
    "organizationId" TEXT,
    "providerSubscriptionId" TEXT,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_event_providerEventId_key" ON "billing_event"("providerEventId");
CREATE INDEX "billing_event_organizationId_idx" ON "billing_event"("organizationId");
CREATE INDEX "billing_event_providerSubscriptionId_idx" ON "billing_event"("providerSubscriptionId");
CREATE INDEX "billing_event_createdAt_idx" ON "billing_event"("createdAt");

ALTER TABLE "billing_event"
    ADD CONSTRAINT "billing_event_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
