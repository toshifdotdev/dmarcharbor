import { Router } from 'express';
import {
  confirmLogoUploadController,
  createLogoUploadController,
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
import { requireFeature } from '../middleware/entitlement.middleware.js';
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

/**
 * Issuing an upload URL and confirming it are both paid capabilities, because
 * both put an asset in a client facing page. The browser PUTs straight to the
 * bucket, so no file bytes pass through this server.
 */
brandingRouter.post(
  '/workspaces/:organizationId/branding/logo/upload',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('branding.logoUpload'),
  createLogoUploadController,
);

brandingRouter.post(
  '/workspaces/:organizationId/branding/logo/confirm',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('branding.logoUpload'),
  confirmLogoUploadController,
);
