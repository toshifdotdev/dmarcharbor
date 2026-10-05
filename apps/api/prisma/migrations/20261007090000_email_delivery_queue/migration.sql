-- Make sent email durable, so a provider blip stops being a lost message.
--
-- `ALTER TYPE ... ADD VALUE` would fail here, because the type does not exist yet on
-- a database that has not had this migration: Postgres has no "create if missing" for
-- an enum, and `ADD VALUE IF NOT EXISTS` only guards against adding a duplicate value
-- to a type that is already there. So the type is created, tolerating the case where a
-- partially applied run left it behind.

DO $$
BEGIN
  CREATE TYPE "EmailDeliveryState" AS ENUM ('PENDING', 'SENT', 'DEAD');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "email_delivery" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "state" "EmailDeliveryState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_delivery_idempotencyKey_key" ON "email_delivery"("idempotencyKey");

-- The sweep query: everything due, oldest first.
CREATE INDEX "email_delivery_state_nextAttemptAt_idx" ON "email_delivery"("state", "nextAttemptAt");

-- The dead letter review: everything that gave up, oldest first.
CREATE INDEX "email_delivery_state_createdAt_idx" ON "email_delivery"("state", "createdAt");