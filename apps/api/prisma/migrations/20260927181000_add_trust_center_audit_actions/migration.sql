-- Audit actions for the public Trust Center.
--
-- Distinct from the isolation and rights data itself: this records that an
-- agency published or withdrew a page making claims about a client's data, who
-- did it, and which link was involved.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TRUST_CENTER_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TRUST_CENTER_REVOKED';
