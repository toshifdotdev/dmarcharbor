-- An endpoint being probed again after its suspension window elapsed.
--
-- A customer whose webhook server was down overnight was left permanently
-- disconnected with nothing telling them, which is the opposite of self healing.
-- Recording the trial means the reconnection is visible in the audit trail
-- rather than looking like the endpoint was never suspended.
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_ENDPOINT_PROBED';
