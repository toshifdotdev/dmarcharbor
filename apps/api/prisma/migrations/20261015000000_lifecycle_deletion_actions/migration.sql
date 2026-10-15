-- Lifecycle deletion actions.
--
-- Removing a domain, a client or a whole workspace was impossible: there was no
-- route, no service and no audit action. An agency that offboarded a client had
-- that client's domains sitting in the workspace forever, still counting against
-- the plan's domain quota and still receiving reports addressed to them.
--
-- Three actions rather than one, because "what was deleted" is the question an
-- auditor asks and "a row was deleted" does not answer it. A domain, a client
-- and a workspace are three different scopes with three different blast radii.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOMAIN_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLIENT_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKSPACE_DELETED';
