-- New audit actions in their own migration: Postgres cannot use a value in the
-- transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PSA_CONNECTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PSA_CONNECTION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PSA_CONNECTION_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PSA_CONNECTION_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PSA_CONNECTION_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PSA_MAPPING_CHANGED';

-- A paused PSA connection is an in-app notification, not a new channel, so it
-- needs its own kind rather than borrowing ALERT and looking like a DMARC alert.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'PSA';
