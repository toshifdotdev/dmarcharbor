-- New audit actions in their own migration: Postgres cannot use a value in the
-- transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DNS_CONNECTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DNS_CONNECTION_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DNS_RECORD_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DNS_RECORD_RESTORED';
