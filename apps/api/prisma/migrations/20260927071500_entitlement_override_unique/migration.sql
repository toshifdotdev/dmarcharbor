-- DropIndex
DROP INDEX "entitlement_override_organizationId_entitlement_idx";

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_override_organizationId_entitlement_key" ON "entitlement_override"("organizationId", "entitlement");
