-- AlterTable
ALTER TABLE "alert_event" ADD COLUMN     "ownerRollupLevel" INTEGER NOT NULL DEFAULT 0;

-- DropIndex
DROP INDEX "alert_delivery_eventId_userId_channel_kind_key";

-- CreateIndex
CREATE UNIQUE INDEX "alert_delivery_eventId_userId_channel_kind_reminderLevel_key" ON "alert_delivery"("eventId", "userId", "channel", "kind", "reminderLevel");
