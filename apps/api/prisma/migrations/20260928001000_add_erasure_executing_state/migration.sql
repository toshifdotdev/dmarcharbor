-- An intermediate state between PENDING and COMPLETED.
--
-- Without it, two API instances both read a due erasure as PENDING, both run
-- the whole deletion, and both send the GDPR completion email. The loser also
-- throws on organization.delete, because the winner has already removed the row
-- it was about to delete, and that throw hides the fact that the erasure
-- actually succeeded.
--
-- EXECUTING lets the claim be a single conditional update, so exactly one
-- instance runs a given erasure.
ALTER TYPE "ErasureState" ADD VALUE 'EXECUTING';

-- Recorded when the claim is taken. Without it a row stranded in EXECUTING by a
-- killed instance could not be told apart from one currently being worked on,
-- and the customer request would never complete.
ALTER TABLE "erasure_request" ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE INDEX "erasure_request_state_claimedAt_idx" ON "erasure_request"("state", "claimedAt");
