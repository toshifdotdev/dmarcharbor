-- AlterEnum
-- Expand-only: three new audit actions for the basic operations an MSP needs
-- (rename a client, move a domain between clients, rename the workspace).
-- In their own migration: Postgres cannot use a value in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE 'CLIENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'DOMAIN_MOVED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_UPDATED';
