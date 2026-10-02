-- Which currency a workspace is quoted and billed in. Defaults to INR because that is
-- the processor we can take money with today.
--
-- Nullable is not an option: the checkout path reads this to decide the provider, and
-- a NULL there would be one more branch deciding which processor to use, which is
-- exactly the decision that should be a stored fact rather than a default expression.

ALTER TABLE "organization" ADD COLUMN "preferredCurrency" "BillingCurrency" NOT NULL DEFAULT 'INR';
