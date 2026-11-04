-- AlterEnum
-- Expand-only. The audit actions for a password reset and for the per-account
-- sign-in brake, and the email delivery state for mail to reserved domains that
-- is written down but never sent.
-- In its own migration: Postgres cannot use a value in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_RESET';
ALTER TYPE "AuditAction" ADD VALUE 'SIGN_IN_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'SIGN_IN_PAUSED';
ALTER TYPE "EmailDeliveryState" ADD VALUE 'SKIPPED';
