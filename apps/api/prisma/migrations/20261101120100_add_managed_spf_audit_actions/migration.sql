-- New audit actions in their own migration: Postgres cannot use a value in the
-- transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MANAGED_SPF_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MANAGED_SPF_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MANAGED_SPF_RELEASE_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MANAGED_SPF_RELEASED';
