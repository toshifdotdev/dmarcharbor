-- AlterTable
-- Expand-only: a nullable column for a per-message From header, so client facing
-- mail from a white-labelled agency can carry the agency's name. Null means
-- "send from EMAIL_FROM", which is what the previous release does for every row,
-- so it keeps working while this one rolls out.
ALTER TABLE "email_delivery" ADD COLUMN "fromHeader" TEXT;
