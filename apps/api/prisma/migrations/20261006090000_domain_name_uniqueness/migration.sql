-- One owner per domain name, globally.
--
-- `Domain.name` was unique only per client, so two tenants could both add
-- `victim.com` and both reach VERIFIED. Report routing resolves a report to a
-- domain by name; finding two rows returned `ambiguous_domain`, and *both* tenants
-- then stopped receiving reports for that domain, permanently, with nothing on
-- either dashboard. One tenant naming a domain another tenant monitors was enough
-- to silently blind them.
--
-- Names are stored lowercased from here on, because a DNS name is case
-- insensitive and routing already compared case insensitively. That is what lets
-- the constraint below be a plain index rather than an expression on
-- lower(name), which Prisma cannot represent and which would leave the model and
-- the database disagreeing.
--
-- Every name is canonicalised, not just the ones that collided. Canonicalising
-- only the renamed rows would leave a pre-existing `Example.com` un-lowercased and
-- a plain unique index would still happily accept `example.com` beside it, which
-- is the same ambiguity this migration exists to remove.
--
-- Existing duplicates are repaired before the index is created, because the index
-- cannot be built while they exist and because leaving them would keep the same
-- silent outage running.
--
-- The survivor is the oldest row, so the earliest customer keeps the domain and
-- their slug, history and reports stay attached to it. A duplicate is renamed
-- rather than deleted: it belongs to a paying tenant who added it in good faith,
-- and deleting it would cascade away their scans, reports, forensic reports, alert
-- rules and shares to fix a uniqueness problem. The renamed row still shows as the
-- domain that tenant added, on their own list, and still resolves in their URLs.
--
-- Renames are reported through NOTICE rather than applied silently. A data repair
-- an operator cannot see is a repair nobody will ever check, and these customers
-- need telling that their domain name changed. A temporary table is used so the
-- schema and the migration history stay in exact parity.

CREATE TEMP TABLE "domain_name_renames" (
    "id"          TEXT PRIMARY KEY,
    "domainId"    TEXT NOT NULL,
    "domainName"  TEXT NOT NULL,
    "renamedTo"   TEXT NOT NULL,
    "clientId"    TEXT NOT NULL
) ON COMMIT DROP;

-- Renames first, and captured exactly.
--
-- The rows that need renaming are the ones with an older row of the same name
-- ignoring case. RETURNING is what records them, rather than matching on the
-- suffix afterwards, which would also match a customer whose real domain happens
-- to contain that text.
--
-- Two rows differing only by case would collide the instant they were lowercased,
-- so this has to happen before canonicalisation.
WITH renamed AS (
    UPDATE "domain" d
    SET "name" = d."name" || '.duplicate-' || substr(md5(d."id" || random()::text), 1, 8)
    WHERE EXISTS (
        SELECT 1
        FROM "domain" other
        WHERE lower(other."name") = lower(d."name")
          AND (other."createdAt", other."id") < (d."createdAt", d."id")
    )
    RETURNING d."id", d."name", d."clientId"
)
INSERT INTO "domain_name_renames" ("id", "domainId", "domainName", "renamedTo", "clientId")
SELECT md5("id" || random()::text), "id", lower("name"), lower("name"), "clientId"
FROM renamed;

-- Then every name, so the constraint below is plain and means what routing assumed.
UPDATE "domain" SET "name" = lower("name");

DO $$
DECLARE
    affected integer;
    line     text;
BEGIN
    SELECT count(*) INTO affected FROM "domain_name_renames";

    IF affected > 0 THEN
        RAISE NOTICE 'dmarcharbor: % domain(s) renamed so that each name has one owner.', affected;
        RAISE NOTICE 'These clients now hold a suffixed domain name and should be told why:';
        FOR line IN
            SELECT '  ' || r."renamedTo" || '  (client ' || r."clientId" || ')'
            FROM "domain_name_renames" r
            ORDER BY r."renamedTo"
        LOOP
            RAISE NOTICE '%', line;
        END LOOP;
    ELSE
        RAISE NOTICE 'dmarcharbor: no duplicate domain names found, nothing renamed.';
    END IF;
END $$;

DROP INDEX "domain_clientId_name_key";

CREATE UNIQUE INDEX "domain_name_key" ON "domain"("name");