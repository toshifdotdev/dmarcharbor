-- Audit action for issuing a signed compliance pack.
--
-- A pack is a public claim about how a client's data is handled, so who issued
-- it and which digest went out is part of the record, not just an application
-- log line.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'COMPLIANCE_PACK_ISSUED';
