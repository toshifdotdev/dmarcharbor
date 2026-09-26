import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { auth } from './auth.config.js';
import type { OrganizationAction, OrganizationResource } from '../middleware/organization-permission.middleware.js';

export async function requestHasOrganizationPermission(
  request: Request,
  organizationId: string,
  resource: OrganizationResource,
  action: OrganizationAction,
): Promise<boolean> {
  try {
    const permission = await auth.api.hasPermission({
      headers: fromNodeHeaders(request.headers),
      body: {
        organizationId,
        permissions: { [resource]: [action] },
      },
    });

    return permission.success;
  } catch {
    return false;
  }
}
