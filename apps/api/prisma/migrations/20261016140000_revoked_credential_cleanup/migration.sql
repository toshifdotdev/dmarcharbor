-- Residue cleanup for revoked share links and revoked API keys.
--
-- Both are revoked by setting `revokedAt` and keeping the row, which is what
-- makes the revocation visible and stops the credential from working. Nothing
-- then removes the row, so a workspace accumulates dead credentials and dead
-- share links indefinitely.
--
-- The revocation itself is already recorded in `audit_log` against the same id
-- (`REPORT_SHARE_REVOKED`, `API_KEY_REVOKED`), so deleting the row destroys
-- nothing that identifies the credential or records that it was ended. These two
-- actions are the record of the residue being cleared.
--
-- Both delete events carry the destroyed metadata - a share link's view count,
-- an API key's name and prefix - because that is the part of the row the audit
-- does not otherwise hold, and it goes when the row goes.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REPORT_SHARE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'API_KEY_DELETED';
