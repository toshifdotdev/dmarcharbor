-- AlterEnum
-- In their own migration: Postgres cannot use a value in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE 'SUBDOMAIN_DISMISSED';
ALTER TYPE "AuditAction" ADD VALUE 'SUBDOMAIN_RESTORED';
