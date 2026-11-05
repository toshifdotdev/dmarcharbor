-- AlterEnum
-- Expand-only. Audit actions for a client or domain added in the web app, a
-- domain becoming verified, and the billing currency being chosen.
-- In its own migration: Postgres cannot use a value in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE 'CLIENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'DOMAIN_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'DOMAIN_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'BILLING_CURRENCY_SET';
