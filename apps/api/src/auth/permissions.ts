import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

const statement = {
  ...defaultStatements,
  // Better Auth's default organization statements are update and delete only,
  // with no read action. Workspace level views such as the erasure preview and
  // the audit trail need a read, so it is declared explicitly here.
  organization: ['read', ...defaultStatements.organization],
  client: ['create', 'read', 'update', 'delete'],
  domain: ['create', 'read', 'update', 'delete'],
  report: ['create', 'read', 'update', 'delete', 'ingest'],
  forensic: ['read', 'ingest', 'purge', 'identify'],
  billing: ['read', 'update'],
} as const;

export const accessControl = createAccessControl(statement);

export const owner = accessControl.newRole({
  organization: statement.organization,
  member: statement.member,
  invitation: statement.invitation,
  client: statement.client,
  domain: statement.domain,
  report: statement.report,
  forensic: statement.forensic,
  billing: statement.billing,
});

export const admin = accessControl.newRole({
  organization: ['read', 'update'],
  member: statement.member,
  invitation: statement.invitation,
  client: statement.client,
  domain: statement.domain,
  report: statement.report,
  forensic: statement.forensic,
  billing: ['read'],
});

export const analyst = accessControl.newRole({
  client: ['read'],
  domain: ['read', 'update'],
  report: ['create', 'read', 'update'],
  forensic: ['read', 'ingest'],
  billing: ['read'],
});

export const viewer = accessControl.newRole({
  client: ['read'],
  domain: ['read'],
  report: ['read'],
  billing: ['read'],
});

export const organizationRoles = {
  owner,
  admin,
  analyst,
  viewer,
};
