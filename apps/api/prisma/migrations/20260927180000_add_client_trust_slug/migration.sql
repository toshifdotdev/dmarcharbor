-- The public Trust Center identifier.
--
-- An enterprise auditor opens this from a link the agency forwards, with no
-- account. A guessable path would let anyone enumerate which clients an agency
-- serves, so the slug is random, unique, and rotatable.
ALTER TABLE "client" ADD COLUMN "trustSlug" TEXT;
CREATE UNIQUE INDEX "client_trustSlug_key" ON "client"("trustSlug");
CREATE INDEX "client_trustSlug_idx" ON "client"("trustSlug");
