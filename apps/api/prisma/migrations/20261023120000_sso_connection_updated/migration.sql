-- An SSO connection can now be changed in place (switched off and on, its
-- label, allowlist, provisioning mode and default role) instead of only being
-- deleted and re-created. Each change is recorded, because the allowlist is
-- the security boundary of the connection.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SSO_CONNECTION_UPDATED';
