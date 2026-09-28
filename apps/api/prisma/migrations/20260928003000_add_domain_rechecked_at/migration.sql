-- When a domain was last picked for a DNS re-check.
--
-- The re-check is what decides a domain is still verified, and it emails the
-- customer when that changes. Every instance starts the re-verification job on
-- boot, so without a claim each one resolves the same DNS record, each one
-- decides the transition happened, and the customer receives the same
-- verification email once per replica. The DNS lookup is also multiplied, which
-- is load pointed at somebody else's resolver.
ALTER TABLE "domain" ADD COLUMN "recheckedAt" TIMESTAMP(3);

-- Read by the job's own query, which filters on status and time.
CREATE INDEX "domain_status_recheckedAt_idx" ON "domain"("status", "recheckedAt");
