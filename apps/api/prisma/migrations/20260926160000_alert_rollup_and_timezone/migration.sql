-- CreateEnum
CREATE TYPE "AlertDeliveryKind" AS ENUM ('ALERT', 'ROLLUP');

-- AlterTable
ALTER TABLE "alert_delivery" ADD COLUMN     "kind" "AlertDeliveryKind" NOT NULL DEFAULT 'ALERT';

-- AlterTable
ALTER TABLE "alert_event" ADD COLUMN     "lastOwnerNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "alert_event" ADD COLUMN     "staleAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notification_preference" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- DropIndex
DROP INDEX "alert_delivery_eventId_userId_channel_reminderLevel_key";

-- CreateIndex
CREATE UNIQUE INDEX "alert_delivery_eventId_userId_channel_kind_key" ON "alert_delivery"("eventId", "userId", "channel", "kind");

-- CreateIndex
CREATE INDEX "alert_event_staleAt_idx" ON "alert_event"("staleAt");
