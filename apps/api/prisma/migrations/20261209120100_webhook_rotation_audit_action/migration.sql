-- AlterEnum
-- Expand-only. The audit action for a webhook signing secret being rotated.
-- In its own migration: Postgres cannot use a value in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_SECRET_ROTATED';
