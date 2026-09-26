-- AlterTable
ALTER TABLE "alert_event" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedById" TEXT,
ADD COLUMN     "reminderLevel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "alert_rule" ADD COLUMN     "maxReminderLevel" INTEGER NOT NULL DEFAULT 3;

-- CreateIndex
CREATE INDEX "alert_event_ruleId_acknowledgedAt_idx" ON "alert_event"("ruleId", "acknowledgedAt");

-- AddForeignKey
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
