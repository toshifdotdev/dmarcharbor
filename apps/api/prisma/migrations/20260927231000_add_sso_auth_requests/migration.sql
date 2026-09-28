-- A single sign on authorisation request that has not come back yet.
--
-- Kept in the database rather than a signed cookie for two reasons: the callback
-- has to be reachable without the original cookie jar, and a cookie signed with
-- one instance's secret would not verify on another instance behind a load
-- balancer.
--
-- The nonce is unique and deleted on use, which is what makes the authorisation
-- response single use. A response captured from a browser and replayed finds no
-- row, so it cannot mint a second session.
CREATE TABLE "sso_auth_request" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    -- The PKCE verifier, held server side so an intercepted authorisation code
    -- cannot be redeemed without it.
    "verifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_auth_request_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sso_auth_request_nonce_key" ON "sso_auth_request"("nonce");

CREATE INDEX "sso_auth_request_createdAt_idx" ON "sso_auth_request"("createdAt");

ALTER TABLE "sso_auth_request" ADD CONSTRAINT "sso_auth_request_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "sso_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
