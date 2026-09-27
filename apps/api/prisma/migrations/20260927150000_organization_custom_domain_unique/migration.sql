-- A hostname can only ever serve one agency, otherwise host based tenant
-- resolution would be ambiguous and two customers could both claim it.
CREATE UNIQUE INDEX "organization_custom_domain_key" ON "organization"("customDomain");
