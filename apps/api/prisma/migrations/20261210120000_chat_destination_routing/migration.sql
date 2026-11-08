-- Several Slack and Teams destinations per workspace, each routed by client
-- and kind. Expand only: two columns with empty defaults (every client, every
-- kind, which is what one destination did) and a plain index in place of the
-- unique one.
ALTER TABLE "slack_destination" ADD COLUMN "clientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "slack_destination" ADD COLUMN "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "teams_destination" ADD COLUMN "clientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "teams_destination" ADD COLUMN "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "slack_destination_organizationId_idx" ON "slack_destination"("organizationId");
CREATE INDEX "teams_destination_organizationId_idx" ON "teams_destination"("organizationId");

-- The previous release writes these rows with an upsert on organizationId; only that upsert (connecting or replacing a channel) can fail during the rotation window.
DROP INDEX "slack_destination_organizationId_key"; -- expand-contract: approved: only the old release's connect upsert fails mid-rotation
DROP INDEX "teams_destination_organizationId_key"; -- expand-contract: approved: as above, for Teams