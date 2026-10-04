-- When a workspace accepted the Data Processing Agreement, and which version.
--
-- Nullable because existing workspaces have not accepted one, and because a null
-- here means "not yet accepted" rather than "accepted nothing". The application
-- treats the two differently: a null is a prompt to accept, never a silent pass.
--
-- AcceptedByEmail is retained alongside the id because the id is a database key and
-- an auditor asks who signed, not which row.

ALTER TABLE "organization"
  ADD COLUMN "dpaAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "dpaVersion" TEXT,
  ADD COLUMN "dpaAcceptedById" TEXT,
  ADD COLUMN "dpaAcceptedByEmail" TEXT;

-- Workspace creation reads this on every request to decide whether to prompt.
CREATE INDEX "organization_dpa_acceptance" ON "organization" ("dpaVersion");