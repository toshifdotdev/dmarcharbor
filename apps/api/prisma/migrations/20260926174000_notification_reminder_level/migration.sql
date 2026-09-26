-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "reminderLevel" INTEGER NOT NULL DEFAULT 1;

-- DropIndex
DROP INDEX "notification_alertEventId_key";

-- CreateIndex
CREATE UNIQUE INDEX "notification_alertEventId_userId_reminderLevel_key" ON "notification"("alertEventId", "userId", "reminderLevel");
