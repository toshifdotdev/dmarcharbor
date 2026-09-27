-- AlterTable
ALTER TABLE "dmarc_report_record" ADD COLUMN     "senderDomain" TEXT,
ADD COLUMN     "senderKey" TEXT;

-- CreateIndex
CREATE INDEX "dmarc_report_record_senderKey_idx" ON "dmarc_report_record"("senderKey");
