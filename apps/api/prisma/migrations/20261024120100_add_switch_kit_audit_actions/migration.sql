-- Four values in their own migration because Postgres cannot use a new enum
-- value in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SWITCH_KIT_IMPORTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOMAIN_SWITCH_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOMAIN_SWITCH_CUT_OVER';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOMAIN_SWITCH_CANCELLED';
