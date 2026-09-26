-- AlterTable
ALTER TABLE "alert_delivery" ADD COLUMN     "reminderLevel" INTEGER NOT NULL DEFAULT 1;

-- DropIndex
DROP INDEX "alert_delivery_eventId_userId_channel_key";

-- CreateIndex
CREATE UNIQUE INDEX "alert_delivery_eventId_userId_channel_reminderLevel_key" ON "alert_delivery"("eventId", "userId", "channel", "reminderLevel");
