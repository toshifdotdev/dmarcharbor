-- Portal access cleanup.
--
-- Revoking a grant sets `revokedAt` and keeps the row, which is what the audit
-- trail needs: it has to show that access existed and that somebody ended it. The
-- consequence was that a revoked contact could never be removed, so the email
-- address of a person who no longer has any access stayed on the product
-- indefinitely - in a product whose GDPR erasure right is a selling point.
--
-- This action is the record of the residue being cleared, after the fact. The
-- revoked grant's own row is gone by the time it is written, so the address is
-- deliberately NOT repeated in `detail`: the point of the delete is to stop
-- holding it.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PORTAL_ACCESS_DELETED';
