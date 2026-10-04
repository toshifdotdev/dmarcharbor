-- One membership per person per workspace.
--
-- `sso-flow.service.ts` provisioned with find-then-create and no constraint behind
-- it, so two callbacks arriving together could both observe no membership and
-- both create one. The duplicate is not cosmetic: `quotaUsage` counts member rows
-- for the `member` quota the plans sell, so a duplicate inflates a number a
-- customer has been sold, and it gives one person two memberships to audit
-- against.
--
-- Existing duplicates are collapsed first. The survivor is the earliest row, so a
-- workspace's history stays in order and nothing that referenced a membership by
-- id is left dangling.
DELETE FROM "member" a
USING "member" b
WHERE a.id > b.id
  AND a."organizationId" = b."organizationId"
  AND a."userId" = b."userId";

CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");