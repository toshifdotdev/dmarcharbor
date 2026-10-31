-- AlterEnum
-- Expand-only: the audit action recorded the first time the email provider
-- reports an agency's own sending domain as verified.
-- In its own migration: Postgres cannot use a value in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE 'SENDING_DOMAIN_VERIFIED';
