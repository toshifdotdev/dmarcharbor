-- Records a quantity pushed to a provider.
--
-- Separate from SUBSCRIPTION_UPDATED because "the domain count changed and we
-- told the provider" is a different fact from "the plan changed", and support
-- asks about the first when a customer disputes a per-domain charge.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BILLING_QUANTITY_UPDATED';
