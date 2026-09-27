import { Router } from 'express';
import {
  grantPortalAccessController,
  listPortalAccessController,
  portalDomainController,
  portalOverviewController,
  revokePortalAccessController,
} from '../controllers/portal.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requirePortalScope } from '../middleware/portal.middleware.js';

export const portalRouter = Router();

/** Management, by agency staff. */
portalRouter.post(
  '/workspaces/:organizationId/clients/:clientId/portal-access',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  grantPortalAccessController,
);
portalRouter.get(
  '/workspaces/:organizationId/portal-access',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  listPortalAccessController,
);
portalRouter.delete(
  '/workspaces/:organizationId/portal-access/:accessId',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  revokePortalAccessController,
);

/** What a client contact sees. Scoped on every route, never by a path parameter alone. */
portalRouter.get('/portal', requireSession, requirePortalScope, portalOverviewController);
portalRouter.get('/portal/domains/:domainId', requireSession, requirePortalScope, portalDomainController);
