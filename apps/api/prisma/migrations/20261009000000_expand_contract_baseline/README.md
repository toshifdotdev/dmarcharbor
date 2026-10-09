# Expand/contract migration barrier

Contracts the safe-migration shape this repository requires.

**This directory contains no migration.sql and is not a migration.** It is a
marker: CI treats it as the point after which migrations must be safe to run
while the previous release is still serving.

The container entrypoint runs prisma migrate deploy before the server listens,
and the replicas it replaces are still in the load balancer rotation. So a
migration cannot assume the old binary is gone, and the statements that make that
assumption are rejected from here onwards:

- ALTER COLUMN ... SET NOT NULL. The old binary's INSERT omits the column and
  there is no default, so every write 500s. 20261002150000_domain_slug did this.
- DROP COLUMN.
- DROP INDEX. Exclusive lock on a table every request writes.
- a whole-table UPDATE. Same lock, for as long as the statement runs.

Each of those needs an expand/contract split: add the new column nullable, deploy
the binary that writes it, then remove in a later release.

The reason this is a marker rather than a check over all of history is that 24
existing migrations contain one of these shapes and all of them predate any
rolling deploy. Moving the marker forward **back** is how a team legitimately says
one more is approved, and it should be a commit that is visible in review.

An individual migration inside the approved range can be exempted by appending
-- expand-contract: approved and a reason on the statement line.
