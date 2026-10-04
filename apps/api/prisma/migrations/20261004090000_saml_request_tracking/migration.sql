-- SAML replay protection.
--
-- The OIDC path already stored its `state` and deleted it on use, so a replayed
-- authorisation response found nothing. The SAML path stored nothing at all:
-- `validateInResponseTo` was left at the library default of `never`, the request
-- id was generated inside the library and thrown away, and RelayState was
-- ignored. A captured assertion could therefore be posted again for a fresh
-- seven day session, indefinitely.
--
-- `nonce` and `verifier` become nullable because a SAML request has neither a
-- PKCE state nor a code verifier; it has a request id and a RelayState instead.
ALTER TABLE "sso_auth_request"
  ALTER COLUMN "nonce" DROP NOT NULL,
  ALTER COLUMN "verifier" DROP NOT NULL;

ALTER TABLE "sso_auth_request"
  ADD COLUMN "relayState" TEXT,
  ADD COLUMN "samlRequestId" TEXT;

CREATE UNIQUE INDEX "sso_auth_request_relayState_key" ON "sso_auth_request"("relayState");
CREATE UNIQUE INDEX "sso_auth_request_samlRequestId_key" ON "sso_auth_request"("samlRequestId");

-- The per-connection and age lookups the SAML cache provider performs on every
-- assertion were previously a full table scan, which the in-memory provider never
-- needed because it never touched the database.
CREATE INDEX "sso_auth_request_connectionId_idx" ON "sso_auth_request"("connectionId");
CREATE INDEX "sso_auth_request_createdAt_idx" ON "sso_auth_request"("createdAt");