-- New enum values in their own migration: Postgres cannot use a value in the
-- transaction that adds it.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'DNS_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DNS_CHANGE_ACKNOWLEDGED';
