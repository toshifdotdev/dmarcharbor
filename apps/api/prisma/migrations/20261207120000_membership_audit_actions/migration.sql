-- AlterEnum
-- Expand-only. Audit actions for invitations, role changes, removals and the
-- ownership transfer, for pausing and resuming a Slack or Teams channel, and
-- for turning failure-report collection on or off.
-- In its own migration: Postgres cannot use a value in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_INVITED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_RESENT';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_CANCELED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_ROLE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_LEFT';
ALTER TYPE "AuditAction" ADD VALUE 'OWNERSHIP_TRANSFERRED';
ALTER TYPE "AuditAction" ADD VALUE 'SLACK_DESTINATION_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE 'SLACK_DESTINATION_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE 'TEAMS_DESTINATION_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE 'TEAMS_DESTINATION_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE 'FORENSIC_COLLECTION_ENABLED';
ALTER TYPE "AuditAction" ADD VALUE 'FORENSIC_COLLECTION_DISABLED';
