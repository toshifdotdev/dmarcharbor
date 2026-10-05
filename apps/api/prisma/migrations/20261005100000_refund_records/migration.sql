-- Refunds, and the purchase date the published guarantee depends on.
--
-- docs/REFUND-POLICY.md and docs/FAQ.md both promise a 30 day money back
-- guarantee on every purchase, monthly and annual, with no reason required.
-- Nothing recorded when a purchase happened, so support could only answer by
-- opening the provider dashboard and guessing from the invoice date. A guessed
-- answer is wrong in one of two directions: either a customer inside the window
-- is refused, or money goes back that should not have.
--
-- `firstChargeAt` is stamped the first time a subscription is seen paid. It is a
-- column rather than a query over billing_event because that table is
-- deduplicated and eventually purged, so an eligibility check reading it would
-- start answering differently as rows disappeared.
--
-- Existing rows get the earliest charge we still hold, and NULL where there is
-- none. NULL is not "eligible", it is "no completed purchase on record", and the
-- service says so rather than producing a confident wrong number.
ALTER TABLE "subscription" ADD COLUMN "firstChargeAt" TIMESTAMP(3);

UPDATE "subscription" s
SET "firstChargeAt" = earliest.charged_at
FROM (
  SELECT DISTINCT ON ("organizationId") "organizationId", "occurredAt" AS charged_at
  FROM "billing_event"
  WHERE "organizationId" IS NOT NULL
    AND type IN ('checkout.completed', 'subscription.activated', 'subscription.updated')
  ORDER BY "organizationId", "occurredAt" ASC
) AS earliest
WHERE s."organizationId" = earliest."organizationId"
  AND s."firstChargeAt" IS NULL;

CREATE TABLE "refund_record" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "provider" "BillingProvider" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL,
    "firstChargeAt" TIMESTAMP(3),
    "eligible" BOOLEAN NOT NULL,
    "refusalReason" TEXT,
    "eligibleUntil" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_record_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refund_record_organizationId_idx" ON "refund_record"("organizationId");
CREATE INDEX "refund_record_createdAt_idx" ON "refund_record"("createdAt");

ALTER TABLE "refund_record"
    ADD CONSTRAINT "refund_record_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;