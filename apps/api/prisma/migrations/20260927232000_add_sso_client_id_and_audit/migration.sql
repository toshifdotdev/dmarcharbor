-- The relying party identifier registered with the customer's identity provider.
--
-- Separate from issuer because they are different values that are easy to
-- confuse: issuer is who the provider is, clientId is who we are to them. Storing
-- only one of them is how a configuration ends up validating against the wrong
-- audience.
ALTER TABLE "sso_connection" ADD COLUMN "clientId" TEXT NOT NULL DEFAULT '';

-- Sign in through a workspace identity provider is a security event, so it is
-- on the audit trail next to password and session changes. The three values are
-- added after the table exists rather than in the creating migration because a
-- previous deployment may already be running that one.
ALTER TYPE "AuditAction" ADD VALUE 'SSO_CONNECTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SSO_CONNECTION_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'SSO_SIGN_IN';
