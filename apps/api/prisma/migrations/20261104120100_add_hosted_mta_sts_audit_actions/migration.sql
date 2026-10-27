-- New audit actions in their own migration: Postgres cannot use a value in the
-- transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HOSTED_MTA_STS_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HOSTED_MTA_STS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HOSTED_MTA_STS_RELEASE_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HOSTED_MTA_STS_RELEASED';
