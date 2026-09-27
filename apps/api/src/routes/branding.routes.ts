import { Router } from 'express';
import {
  getBrandingController,
  getStoredBrandingController,
  portalBrandingController,
  resolveBrandingByHostController,
  setCustomDomainController,
  updateBrandingController,
  verifyCustomDomainController,
} from '../controllers/branding.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requirePortalScope } from '../middleware/portal.middleware.js';

export const brandingRouter = Router();

/** Agency side. */
brandingRouter.get(
  '/workspaces/:organizationId/branding',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  getStoredBrandingController,
);
brandingRouter.patch(
  '/workspaces/:organizationId/branding',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  updateBrandingController,
);
brandingRouter.put(
  '/workspaces/:organizationId/branding/custom-domain',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  setCustomDomainController,
);
brandingRouter.post(
  '/workspaces/:organizationId/branding/custom-domain/verify',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  verifyCustomDomainController,
);

/** Client facing. Scoped like the rest of the portal. */
brandingRouter.get('/branding/host', resolveBrandingByHostController);
brandingRouter.get('/portal/branding', requireSession, requirePortalScope, portalBrandingController);
brandingRouter.get(
  '/workspaces/:organizationId/branding/resolved',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  getBrandingController,
);
