-- Counters for the rate limiters, shared across every replica.
--
-- `express-rate-limit` defaults to an in-process Map, which means each replica
-- enforces its own full budget: with three replicas behind a load balancer a limit
-- written as 600 per minute is really 1800 per minute, and no deploy ever resets it
-- because there is nothing to reset. A per-process limit is not a limit.
--
-- Keyed by the limiter name and the generated key rather than by request, so one row
-- holds one bucket. The composite primary key is what makes the increment atomic: two
-- replicas counting the same request cannot both read, add one and write, because the
-- second write waits for the first.
CREATE TABLE "rate_limit_bucket" (
    "key"       TEXT NOT NULL,
    "limiter"    TEXT NOT NULL,
    "hits"       INTEGER NOT NULL DEFAULT 0,
    "resetAt"    TIMESTAMP(3) NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("key", "limiter")
);

-- The sweep query: buckets whose window has closed.
CREATE INDEX "rate_limit_bucket_resetAt_idx" ON "rate_limit_bucket"("resetAt");