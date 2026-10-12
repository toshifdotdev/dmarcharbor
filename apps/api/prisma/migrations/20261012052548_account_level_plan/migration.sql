-- AlterTable
ALTER TABLE "user" ADD COLUMN     "pendingPlan" "PlanTier",
ADD COLUMN     "plan" "PlanTier" NOT NULL DEFAULT 'MOORING',
ADD COLUMN     "preferredCurrency" "BillingCurrency" NOT NULL DEFAULT 'INR';
