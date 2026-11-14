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

/**
 * Staff roles only.
 *
 * Client contacts are not members. They hold ClientPortalAccess grants, which
 * the portal routes read and scope to the granted clients. A `portal` member
 * role used to be registered here with client, domain and report read across
 * the whole workspace: nothing created it, but an owner or admin could assign
 * it through invite-member or update-member-role, and the person then read
 * every client, every domain and every contact's address on the staff routes.
 * Unregistered, the organization plugin refuses it as an unknown role.
 */
export const organizationRoles = {
  owner,
  admin,
  analyst,
  viewer,
};

/** Every role a member may hold. Anything else in a member row is refused. */
export const staffRoleNames = ['owner', 'admin', 'analyst', 'viewer'] as const;
