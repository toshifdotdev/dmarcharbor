-- New audit actions in their own migration: Postgres cannot use a value in the
-- transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SENDER_REVIEWED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SENDER_OWNER_SET';
