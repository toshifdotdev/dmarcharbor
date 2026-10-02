-- AlterTable
ALTER TABLE "subscription" ADD COLUMN     "graceEndsAt" TIMESTAMP(3),
ADD COLUMN     "pendingPlan" "PlanTier",
ADD COLUMN     "pendingPlanInterval" "BillingInterval";
