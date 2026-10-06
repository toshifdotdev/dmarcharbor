-- Two audit actions that refunds write, and no migration ever added them.
--
-- `REFUND_ISSUED` and `REFUND_REFUSED` were declared in `schema.prisma` and used by
-- `refund.service.ts`, but the PostgreSQL enum only grew as far as `DPA_ACCEPTED`.
-- Prisma's generated client types a value the database rejects, so the write compiles,
-- type-checks and passes lint, then fails at runtime with an invalid input value for
-- enum "AuditAction".
--
-- Nothing caught it because `issueRefund` had no test that reached it: the refund suite
-- covered eligibility and route authorisation, so the first write to the audit table
-- was going to be a live customer's refund.
--
-- `ADD VALUE IF NOT EXISTS` because the enum is append-only here and re-running a
-- migration must not fail the boot.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REFUND_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REFUND_REFUSED';

-- Prisma derives index names from the fields they cover and offers no way to override
-- the name, so declaring `@@index([dpaVersion])` implies `organization_dpaVersion_idx`
-- while migration `20261002210000_dpa_acceptance` created `organization_dpa_acceptance`.
-- Left alone, that reads as drift to `prisma migrate diff` and the index gets dropped
-- by the next `prisma migrate dev`, taking the compliance re-consent lookup with it.
--
-- Renamed rather than dropped and recreated so the index stays built for the re-consent
-- sweep and so there is no window without it.
ALTER INDEX "organization_dpa_acceptance" RENAME TO "organization_dpaVersion_idx";
