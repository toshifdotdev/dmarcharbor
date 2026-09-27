-- Audit actions for billing state changes. Subscription changes are attributed
-- to the provider rather than a user, so a plan movement is always traceable
-- back to a verified webhook rather than appearing to be a silent edit.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAYMENT_FAILED';
