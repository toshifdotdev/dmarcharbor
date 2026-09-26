import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';

export type OrganizationResource = 'client' | 'domain' | 'report' | 'billing';
export type OrganizationAction = 'create' | 'read' | 'update' | 'delete' | 'ingest';

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
