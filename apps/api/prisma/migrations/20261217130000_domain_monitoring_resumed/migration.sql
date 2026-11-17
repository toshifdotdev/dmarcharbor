-- A resumed domain takes a place on the plan for the grace period, like a newly
-- added one (inventory.service.ts countedDomainWhere). Expand only.
-- AlterTable
ALTER TABLE "domain" ADD COLUMN "monitoringResumedAt" TIMESTAMP(3);
