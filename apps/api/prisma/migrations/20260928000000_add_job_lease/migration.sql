-- A short lived claim on running one named job.
--
-- This exists because every scheduler starts on boot, so an autoscaled
-- deployment runs each job once per instance. Node being single threaded means
-- an in-process flag is enough to stop one process overlapping itself, but it
-- cannot know about the other processes.
--
-- Acquired with a single conditional upsert, so it is a transaction scoped
-- statement and therefore safe on a pooled connection. It expires on its own,
-- so an instance killed mid job releases it without a reaper, which is the
-- property an advisory lock does not have.
CREATE TABLE "job_lease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_lease_pkey" PRIMARY KEY ("name")
);

CREATE INDEX "job_lease_expiresAt_idx" ON "job_lease"("expiresAt");
