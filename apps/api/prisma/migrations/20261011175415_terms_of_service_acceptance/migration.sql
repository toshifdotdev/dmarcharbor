-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "tosAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "tosAcceptedByEmail" TEXT,
ADD COLUMN     "tosVersion" TEXT;
