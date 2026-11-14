import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { prisma } from '../database/prisma.js';
import {
  fullPath,
  isDpaAcceptancePath,
  workspaceDpaRefusal,
  workspaceMfaRefusal,
} from './workspace-gates.js';

export type OrganizationResource = 'client' | 'domain' | 'report' | 'forensic' | 'billing' | 'organization' | 'member';
export type OrganizationAction = 'create' | 'read' | 'update' | 'delete' | 'ingest' | 'purge' | 'identify';

/**
 * The workspace's two-step and DPA requirements, for a caller already known to
 * be a member of it.
 *
 * Run here, against the decoded route parameter, as well as by the global
 * gates that read the path. The global gates matched the path as written, so
 * `/api/Workspaces/<id>` or a percent-encoded id passed them while this route
 * matched and served the request (workspace-gates.ts). This also covers the
 * routers mounted ahead of the global DPA gate, which used to be outside it.
 * What the global gates already checked for this workspace is not read again.
 */
async function workspaceGatesRefused(request: Request, response: Response, organizationId: string): Promise<boolean> {
  try {
    if (response.locals.mfaCheckedFor !== organizationId) {
      const refusal = await workspaceMfaRefusal(organizationId, response.locals.session);
      if (refusal) {
        response.status(refusal.status).json(refusal.body);
        return true;
      }
      response.locals.mfaCheckedFor = organizationId;
    }

    if (response.locals.dpaCheckedFor !== organizationId && !isDpaAcceptancePath(fullPath(request))) {
      const refusal = await workspaceDpaRefusal(organizationId);
      if (refusal) {
        response.status(refusal.status).json(refusal.body);
        return true;
      }
      response.locals.dpaCheckedFor = organizationId;
    }
  } catch {
    // Same reading as the global gates: a requirement that cannot be read is
    // not enforced during a database blip, and the route fails on its own if
    // the database is really gone.
  }
  return false;
}

/**
 * Any member of the agency's team: owner, admin, analyst or viewer.
 *
 * For screens that only read something every team member has reason to know,
 * such as where alerts are posted. No permission resource says that on its
 * own, because `organization:read` is owner and admin (it opens exports).
 */
export function requireWorkspaceTeam() {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const organizationId = typeof request.params.organizationId === 'string' ? request.params.organizationId : undefined;
    const userId = response.locals.session?.user?.id as string | undefined;
    if (!organizationId) {
      response.status(400).json({ error: { message: 'A workspace identifier is required.' } });
      return;
    }
    const member = userId
      ? await prisma.member.findFirst({ where: { organizationId, userId }, select: { role: true } })
      : null;
    const roles = (member?.role ?? '').split(',').map((role) => role.trim());
    if (!roles.some((role) => ['owner', 'admin', 'analyst', 'viewer'].includes(role))) {
      response.status(403).json({ error: { message: 'You do not have permission for this workspace action.' } });
      return;
    }
    if (await workspaceGatesRefused(request, response, organizationId)) {
      return;
    }
    response.locals.organizationId = organizationId;
    next();
  };
}

export function requireOrganizationPermission(resource: OrganizationResource, action: OrganizationAction) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const organizationId = typeof request.params.organizationId === 'string' ? request.params.organizationId : undefined;

    if (!organizationId) {
      response.status(400).json({ error: { message: 'A workspace identifier is required.' } });
      return;
    }

    let permitted: boolean;
    try {
      const permission = await auth.api.hasPermission({
        headers: fromNodeHeaders(request.headers),
        body: {
          organizationId,
          permissions: { [resource]: [action] },
        },
      });
      permitted = permission.success;
    } catch {
      response.status(403).json({ error: { message: 'You are not a member of this workspace.' } });
      return;
    }

    if (!permitted) {
      response.status(403).json({ error: { message: 'You do not have permission for this workspace action.' } });
      return;
    }

    if (await workspaceGatesRefused(request, response, organizationId)) {
      return;
    }

    response.locals.organizationId = organizationId;
    next();
  };
}
