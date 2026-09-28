-- The signed compliance pack.
--
-- The PDF itself is not stored. Bytes are not evidence, the hash is: keeping a
-- copy would mean the thing we are attesting to is also the thing we could
-- accidentally overwrite. What is kept is the SHA-256 of the exact bytes that
-- were served, plus enough metadata to explain what the document covered.
--
-- History is retained rather than replaced, because an auditor may be holding
-- an older pack and the answer to "was this one ever issued" has to survive a
-- later regeneration.
CREATE TABLE "compliance_pack" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "pdfHash" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "generatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_pack_pkey" PRIMARY KEY ("id")
);

-- The hash is the public claim, so two live packs for one client and version
-- would make verification ambiguous.
CREATE UNIQUE INDEX "compliance_pack_hash_key" ON "compliance_pack"("pdfHash");
CREATE INDEX "compliance_pack_client_idx" ON "compliance_pack"("clientId");
CREATE INDEX "compliance_pack_organization_idx" ON "compliance_pack"("organizationId");
CREATE INDEX "compliance_pack_createdAt_idx" ON "compliance_pack"("createdAt");

ALTER TABLE "compliance_pack"
    ADD CONSTRAINT "compliance_pack_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compliance_pack"
    ADD CONSTRAINT "compliance_pack_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
