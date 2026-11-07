-- AlterTable
-- Expand-only. A rotated signing secret keeps the previous one for an overlap,
-- and an endpoint can be limited to chosen clients (empty means every client).
ALTER TABLE "webhook_endpoint" ADD COLUMN "previousSecret" TEXT,
ADD COLUMN "previousSecretExpiresAt" TIMESTAMP(3),
ADD COLUMN "clientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
