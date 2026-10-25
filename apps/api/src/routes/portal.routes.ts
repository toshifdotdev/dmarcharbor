import { Router } from 'express';
import {
  deleteAllRevokedPortalAccessController,
  deleteRevokedPortalAccessController,
  grantPortalAccessController,
  listPortalAccessController,
  portalDomainController,
  portalOverviewController,
  revokePortalAccessController,
} from '../controllers/portal.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requirePortalScope } from '../middleware/portal.middleware.js';
import {
  portalDownloadMonthlyReportController,
  portalListMonthlyReportsController,
} from '../controllers/monthly-report.controller.js';

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
/**
 * Removing revoked residue, which is a different act from revoking.
 *
 * Declared BEFORE `/:accessId` so "revoked" is never read as an access id. Express
 * matches in registration order, so with this the other way round `DELETE
 * /portal-access/revoked` was swallowed by the parameter route and answered 404
 * for a grant that does not exist - which is precisely what it did.
 */
portalRouter.delete(
  '/workspaces/:organizationId/portal-access/revoked',
  requireSession,
  requireOrganizationPermission('client', 'delete'),
  deleteAllRevokedPortalAccessController,
);
portalRouter.delete(
  '/workspaces/:organizationId/portal-access/:accessId/permanent',
  requireSession,
  requireOrganizationPermission('client', 'delete'),
  deleteRevokedPortalAccessController,
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
portalRouter.get(
  '/portal/clients/:clientId/monthly-reports',
  requireSession,
  requirePortalScope,
  portalListMonthlyReportsController,
);
portalRouter.get(
  '/portal/clients/:clientId/monthly-reports/:reportId/download',
  requireSession,
  requirePortalScope,
  portalDownloadMonthlyReportController,
);
