-- Audit actions for the self service billing actions a customer takes.
--
-- Distinct from SUBSCRIPTION_UPDATED, which is written by the state machine
-- from a provider webhook. Keeping them separate means a support question of
-- "when did this customer cancel" can be answered from what the customer did,
-- and "when did we change their plan" from what the provider told us.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BILLING_CHECKOUT_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BILLING_PLAN_CHANGE_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BILLING_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BILLING_RESUMED';
