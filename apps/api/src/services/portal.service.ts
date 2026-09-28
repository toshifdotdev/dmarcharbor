import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from './audit.service.js';
import { sendPortalAccessGrantedEmail } from '../email/mailer.js';

export interface PortalGrant {
  id: string;
  clientId: string;
  clientName: string;
  organizationId?: string;
  email: string;
  displayName: string | null;
  active: boolean;
  bound: boolean;
  firstSeenAt: string | null;
  createdAt: string;
}

function toGrant(row: {
  id: string;
  clientId: string;
  email: string;
  displayName: string | null;
  revokedAt: Date | null;
  firstSeenAt: Date | null;
  userId?: string | null;
  createdAt: Date;
  client: { name: string };
}): PortalGrant {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client.name,
    email: row.email,
    displayName: row.displayName,
    active: row.revokedAt === null,
    // False until the invited person has actually signed in once, so an
    // agency can tell an invitation that was accepted from one that was not.
    bound: row.userId !== null && row.userId !== undefined,
    firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Grants a client contact access to exactly one client.
 *
 * The grant is created against an email address rather than an account,
 * because the agency should never set a password on behalf of somebody
 * else's staff. The grant carries no user id until that person signs in with
 * the same address, at which point it binds to their account. That works with
 * a password, and equally with Google or Microsoft sign in.
 */
export async function grantPortalAccess(input: {
  organizationId: string;
  clientId: string;
  email: string;
  displayName?: string | null;
  invitedById?: string | null;
}): Promise<PortalGrant | null> {
  const email = input.email.trim().toLowerCase();

  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { id: true, name: true },
  });

  if (!client) {
    return null;
  }

  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  const row = await prisma.clientPortalAccess.upsert({
    where: { clientId_email: { clientId: input.clientId, email } },
    create: {
      clientId: input.clientId,
      organizationId: input.organizationId,
      email,
      userId: existingUser?.id ?? null,
      displayName: input.displayName ?? null,
      invitedById: input.invitedById ?? null,
    },
    update: {
      revokedAt: null,
      displayName: input.displayName ?? null,
      ...(existingUser ? { userId: existingUser.id } : {}),
    },
    include: { client: { select: { name: true } } },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.invitedById ?? undefined,
    action: 'PORTAL_ACCESS_GRANTED',
    targetType: 'client_portal_access',
    targetId: row.id,
    detail: { clientName: client.name, email, displayName: input.displayName ?? null },
  });

  // A contact who is never told about the grant simply never signs in, so the
  // agency has to be able to say who was invited. Fire and forget, because a
  // bounced email must not fail the grant that already succeeded.
  void sendPortalAccessGrantedEmail({
    organizationId: input.organizationId,
    clientId: input.clientId,
    contactEmail: email,
  });

  return toGrant(row);
}

export async function listPortalAccess(organizationId: string, clientId?: string): Promise<PortalGrant[]> {
  const rows = await prisma.clientPortalAccess.findMany({
    where: { organizationId, ...(clientId ? { clientId } : {}) },
    include: { client: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((row) => toGrant(row));
}

export async function revokePortalAccess(
  organizationId: string,
  grantId: string,
  actorUserId?: string | null,
): Promise<boolean> {
  const existing = await prisma.clientPortalAccess.findFirst({
    where: { id: grantId, organizationId, revokedAt: null },
    include: { client: { select: { name: true } } },
  });

  if (!existing) {
    return false;
  }

  await prisma.clientPortalAccess.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });

  await recordAuditEvent({
    organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'PORTAL_ACCESS_REVOKED',
    targetType: 'client_portal_access',
    targetId: existing.id,
    detail: { clientName: existing.client.name, email: existing.email },
  });

  return true;
}

/**
 * Resolves which clients a signed in person may see, and binds any grant that
 * was waiting on their address.
 *
 * An email match is the join. A person invited as acme@client.com who signs
 * in with that address gains exactly the clients they were invited to, and
 * nothing else in the workspace, whatever their internal role can see.
 */
export async function resolvePortalClients(
  organizationId: string,
  email: string,
  now = new Date(),
): Promise<{ clientIds: string[]; grants: PortalGrant[] }> {
  const normalised = email.trim().toLowerCase();

  const rows = await prisma.clientPortalAccess.findMany({
    where: { organizationId, email: normalised, revokedAt: null },
    include: { client: { select: { name: true } } },
  });

  if (rows.length === 0) {
    return { clientIds: [], grants: [] };
  }

  const user = await prisma.user.findUnique({ where: { email: normalised }, select: { id: true } });

  const grants: PortalGrant[] = [];

  for (const row of rows) {
    if (user && (row.userId !== user.id || row.firstSeenAt === null)) {
      await prisma.clientPortalAccess.update({
        where: { id: row.id },
        data: { userId: user.id, ...(row.firstSeenAt === null ? { firstSeenAt: now } : {}) },
      });
    }

    grants.push(toGrant({ ...row, userId: user?.id ?? null, firstSeenAt: row.firstSeenAt ?? now }));
  }

  return { clientIds: rows.map((row) => row.clientId), grants };
}

export async function hasPortalAccess(organizationId: string, clientId: string, email: string): Promise<boolean> {
  const row = await prisma.clientPortalAccess.findFirst({
    where: { organizationId, clientId, email: email.trim().toLowerCase(), revokedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Resolves every live grant held for one email address, across all workspaces.
 *
 * A client contact is deliberately not made a member of the agency workspace.
 * Membership is how staff roles work, and a contact has no staff role, so
 * leaving them out means every other workspace route already refuses them and
 * the portal is the only surface they can reach. Their access is described
 * entirely by these grants.
 */
export async function resolvePortalGrantsForEmail(email: string, now = new Date()): Promise<PortalGrant[]> {
  const normalised = email.trim().toLowerCase();
  const rows = await prisma.clientPortalAccess.findMany({
    where: { email: normalised, revokedAt: null },
    include: { client: { select: { name: true, organizationId: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // Bind on the first request, so the agency can tell an invitation that was
  // accepted from one that was never opened.
  const user = await prisma.user.findUnique({ where: { email: normalised }, select: { id: true } });

  if (user) {
    for (const row of rows) {
      if (row.userId !== user.id || row.firstSeenAt === null) {
        await prisma.clientPortalAccess.update({
          where: { id: row.id },
          data: { userId: user.id, ...(row.firstSeenAt === null ? { firstSeenAt: now } : {}) },
        });
        row.userId = user.id;
        row.firstSeenAt = row.firstSeenAt ?? now;
      }
    }
  }

  return rows.map((row) => ({
    ...toGrant({
      id: row.id,
      clientId: row.clientId,
      email: row.email,
      displayName: row.displayName,
      revokedAt: row.revokedAt,
      firstSeenAt: row.firstSeenAt,
      userId: row.userId,
      createdAt: row.createdAt,
      client: { name: row.client.name },
    }),
    organizationId: row.organizationId,
  }));
}
