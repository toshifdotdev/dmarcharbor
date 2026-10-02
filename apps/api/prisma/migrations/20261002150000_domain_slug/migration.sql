-- A stable, human-readable identifier for URLs.
--
-- Added nullable, backfilled, then tightened. One statement would fail on any
-- existing row, and the backfill has to give every row a distinct value or the
-- unique index cannot be built.

ALTER TABLE "domain" ADD COLUMN "slug" TEXT;

-- Domain names are already close to unique in practice, so sanitising the name is
-- what a human would have typed anyway. Anything that collides, or that sanitised
-- to nothing, gets a short suffix taken from the row id, which stays stable and
-- reproducible rather than random.
UPDATE "domain" d
SET "slug" = base.cleaned
  || CASE
       WHEN EXISTS (
         SELECT 1 FROM "domain" d2
         WHERE COALESCE(
           NULLIF(regexp_replace(lower(d2."name"), '[^a-z0-9]+', '-', 'g'), ''),
           'domain'
         ) = base.cleaned
         AND d2."id" <> d."id"
       )
       THEN '-' || substr(replace(d."id", '-', ''), -6)
       ELSE ''
     END
FROM (
  SELECT "id",
         COALESCE(
           NULLIF(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), ''),
           'domain'
         ) AS cleaned
  FROM "domain"
) AS base
WHERE base."id" = d."id";

CREATE UNIQUE INDEX "domain_slug_key" ON "domain"("slug");

ALTER TABLE "domain" ALTER COLUMN "slug" SET NOT NULL;