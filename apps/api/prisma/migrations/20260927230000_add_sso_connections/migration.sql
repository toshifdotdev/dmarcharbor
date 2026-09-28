-- Enterprise single sign on, one connection per identity provider per workspace.
--
-- The client secret is stored in its own column rather than a generic settings
-- blob so it is impossible to return it as part of a workspace settings read by
-- accident. It holds account level access to the customer's identity provider.
--
-- Permitted email domains live in their own table because that allowlist is the
-- entire security boundary for just in time provisioning: with it, a workspace
-- can let its own directory vouch for a person, and without it, anyone who can
-- authenticate to any IdP on the internet could provision themselves in.
CREATE TYPE "SsoProtocol" AS ENUM ('SAML', 'OIDC');
CREATE TYPE "SsoProvisioningMode" AS ENUM ('JIT', 'DISABLED');

CREATE TABLE "sso_connection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "protocol" "SsoProtocol" NOT NULL,
    "issuer" TEXT NOT NULL,
    "entryPoint" TEXT NOT NULL,
    "idpCertificate" TEXT,
    "tokenEndpoint" TEXT,
    "userinfoEndpoint" TEXT,
    "clientSecretEncrypted" TEXT NOT NULL,
    "provisioning" "SsoProvisioningMode" NOT NULL DEFAULT 'JIT',
    "defaultRole" TEXT NOT NULL DEFAULT 'analyst',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_connection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sso_connection_domain" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,

    CONSTRAINT "sso_connection_domain_pkey" PRIMARY KEY ("id")
);

-- Cascading on the connection so removing a provider cannot leave behind
-- domains that would then be matched against nothing.
CREATE INDEX "sso_connection_organizationId_idx" ON "sso_connection"("organizationId");

-- The domain check is a lookup on every assertion, and the unique pair is what
-- stops the same domain being added twice and reported twice in the settings UI.
CREATE UNIQUE INDEX "sso_connection_domain_connectionId_domain_key" ON "sso_connection_domain"("connectionId", "domain");

ALTER TABLE "sso_connection" ADD CONSTRAINT "sso_connection_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sso_connection_domain" ADD CONSTRAINT "sso_connection_domain_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "sso_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
