import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { prisma } from '../database/prisma.js';

export type OrganizationResource = 'client' | 'domain' | 'report' | 'forensic' | 'billing' | 'organization' | 'member';
export type OrganizationAction = 'create' | 'read' | 'update' | 'delete' | 'ingest' | 'purge' | 'identify';

/**
 * Any member of the agency's team: owner, admin, analyst or viewer, and not a
 * client contact (the `portal` role).
 *
 * For screens that only read something every team member has reason to know,
 * such as where alerts are posted. No permission resource says that on its
 * own: `client:read` and `report:read` are held by portal contacts too, and
 * `organization:read` is owner and admin (it opens exports).
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

    try {
      const permission = await auth.api.hasPermission({
        headers: fromNodeHeaders(request.headers),
        body: {
          organizationId,
          permissions: { [resource]: [action] },
        },
      });

      if (!permission.success) {
        response.status(403).json({ error: { message: 'You do not have permission for this workspace action.' } });
        return;
      }

      response.locals.organizationId = organizationId;
      next();
    } catch {
      response.status(403).json({ error: { message: 'You are not a member of this workspace.' } });
    }
  };
}
