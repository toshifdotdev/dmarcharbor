-- AlterTable
ALTER TABLE "dmarc_forensic_report" ADD COLUMN     "envelopeFrom" TEXT,
ADD COLUMN     "piiRetained" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recipientAddresses" JSONB,
ADD COLUMN     "subjectLine" TEXT;

-- AlterTable
ALTER TABLE "domain" ADD COLUMN     "forensicPiiEnabledAt" TIMESTAMP(3),
ADD COLUMN     "forensicPiiEnabledById" TEXT,
ADD COLUMN     "retainForensicPii" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "domain" ADD CONSTRAINT "domain_forensicPiiEnabledById_fkey" FOREIGN KEY ("forensicPiiEnabledById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
