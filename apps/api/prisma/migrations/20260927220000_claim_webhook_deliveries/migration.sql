-- Webhook deliveries are claimed before they are sent, not after.
--
-- Previously a delivery row was read, the HTTP request was issued, and only
-- then was the status written. With more than one API instance every instance
-- read the same due rows and every instance sent them, so a customer received
-- each event as many times as there were replicas. The retry budget was broken
-- by the same race, because two real attempts were both counted from the same
-- stale read of the attempts column.
--
-- IN_FLIGHT is the claim marker. A row is only sent by the instance that moved
-- it out of PENDING, and claimedAt is the lease: if that instance dies
-- mid-request, the lease expires and the row returns to PENDING for someone
-- else to retry rather than being stranded.
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'IN_FLIGHT';

-- Added separately from the enum value because Prisma wraps a migration in a
-- transaction, which PostgreSQL does not allow for ALTER TYPE ... ADD VALUE on
-- versions before 13.
ALTER TABLE "webhook_delivery" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "webhook_delivery" ADD COLUMN "claimedBy" TEXT;

-- The claim query filters on status and nextAttemptAt, so the index is
-- extended rather than added, keeping the same shape the scheduler reads.
DROP INDEX "webhook_delivery_status_nextAttemptAt_idx";
CREATE INDEX "webhook_delivery_status_nextAttemptAt_idx" ON "webhook_delivery"("status", "nextAttemptAt", "createdAt");
