import type { Request } from 'express';
import { staffRoleNames } from '../auth/permissions.js';
import { prisma } from '../database/prisma.js';
import { dpaAcceptanceFor } from '../services/dpa-acceptance.service.js';

/**
 * The two workspace requirements every workspace route is held to: the
 * workspace's "require two-step verification" setting, and acceptance of the
 * current Data Processing Agreement.
 *
 * Both used to be enforced only by global middleware that read the workspace id
 * out of the raw path with a case-sensitive pattern. Express matches routes
 * case-insensitively and decodes route parameters, so `/api/Workspaces/<id>/…`
 * and `/api/workspaces/%63…` reached the route with a valid workspace while the
 * gates found none and let the request through: a stolen password was enough
 * in a workspace that requires a second factor. The decision now lives here
 * and runs again inside the permission middleware, against the decoded
 * `request.params.organizationId` the route itself uses, so a spelling the
 * router accepts can no longer skip it. The global gates stay as the first
 * layer and record what they checked, so the common case reads nothing twice.
 */

const WORKSPACE_SEGMENT = /\/workspaces\/([^/?#]+)/i;

/** The DPA route records a new acceptance, so it can never be refused for lacking one. */
const ACCEPTANCE_PATH = /\/workspaces\/[^/]+\/dpa-acceptance\/?$/i;

/**
 * The workspace id a path names, decoded the way the router decodes route
 * parameters. `undefined` when the path names no workspace, `null` when the
 * segment cannot be decoded (the router would refuse it too).
 */
export function workspaceIdFromPath(path: string): string | null | undefined {
  const raw = WORKSPACE_SEGMENT.exec(path)?.[1];
  if (raw === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The path the request was made to, from the mount point down. */
export function fullPath(request: Request): string {
  return `${request.baseUrl ?? ''}${request.path ?? ''}`;
}

export function isDpaAcceptancePath(path: string): boolean {
  return ACCEPTANCE_PATH.test(path);
}

export interface GateRefusal {
  status: number;
  body: { error: Record<string, unknown> };
}

interface GateSession {
  user: { id: string; twoFactorEnabled?: boolean | null };
  session: { authMethod?: string | null };
}

/**
 * Null when the member may use the workspace, or the refusal to send.
 *
 * Not a refusal when there is no session or no membership: the route's own
 * middleware answers those, and an MFA error in their place would mislead.
 */
export async function workspaceMfaRefusal(
  organizationId: string,
  session: GateSession | null | undefined,
): Promise<GateRefusal | null> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, requireMfa: true },
  });
  if (!organization?.requireMfa || !session?.user?.id) {
    return null;
  }

  const member = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId, userId: session.user.id } },
    select: { role: true },
  });
  const staff = (member?.role ?? '')
    .split(',')
    .map((role) => role.trim())
    .some((role) => (staffRoleNames as readonly string[]).includes(role));
  if (!staff) {
    // Not a member, or a row naming no staff role: the permission middleware
    // owns that answer, and it is a refusal either way.
    return null;
  }

  if (session.user.twoFactorEnabled || session.session?.authMethod === 'sso') {
    return null;
  }

  return {
    status: 403,
    body: {
      error: {
        code: 'MFA_REQUIRED',
        message: `${organization.name} requires two-step verification. Turn it on for your account to continue.`,
        workspaceName: organization.name,
        setupUrl: '/account/security',
      },
    },
  };
}

/** Null when the workspace's DPA acceptance is current, or the refusal to send. */
export async function workspaceDpaRefusal(organizationId: string): Promise<GateRefusal | null> {
  const acceptance = await dpaAcceptanceFor(organizationId);
  if (!acceptance.requiresReconsent) {
    return null;
  }
  return {
    status: 409,
    body: {
      error: {
        code: 'DPA_RECONSENT_REQUIRED',
        message: 'The Data Processing Agreement has changed and needs to be accepted again.',
        dpaUrl: acceptance.dpaUrl,
        acceptedVersion: acceptance.version,
        currentVersion: acceptance.currentVersion,
      },
    },
  };
}
