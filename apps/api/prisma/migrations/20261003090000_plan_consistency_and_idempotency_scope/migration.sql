-- Plan consistency and per-workspace idempotency.
--
-- Two structural problems, both of which let two records that must never
-- disagree do exactly that.

-- 1. Event ordering. Both providers redeliver out of order and neither the
--    subscription row nor the payload carried a timestamp we could compare, so a
--    late `subscription.activated` could overwrite a cancellation. Nullable, so
--    existing rows are treated as "no ordering information" rather than being
--    backdated into a position they never had.
ALTER TABLE "subscription" ADD COLUMN "lastEventAt" TIMESTAMP(3);

-- 2. Idempotency namespace. `key` was globally unique, which merged every
--    customer's retry namespace into one. Reusing another workspace's key
--    overwrote that workspace's stored response body while leaving its
--    organizationId in place, so the next legitimate replay returned the wrong
--    workspace's client ids and verification values to the original caller.
--
--    Any rows that collided across workspaces are removed first: they are
--    cached responses, not source of truth, and the key is the caller's to
--    choose again. Only the earliest row per (organization, key) survives.
DELETE FROM "idempotency_record" a
USING "idempotency_record" b
WHERE a.id > b.id
  AND a."organizationId" = b."organizationId"
  AND a.key = b.key;

DROP INDEX "idempotency_record_key_key";

CREATE UNIQUE INDEX "idempotency_record_organizationId_key_key" ON "idempotency_record"("organizationId", key);