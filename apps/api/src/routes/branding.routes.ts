import { Router, raw } from 'express';
import {
  confirmLogoUploadController,
  createLogoUploadController,
  getBrandingController,
  getStoredBrandingController,
  portalBrandingController,
  resolveBrandingByHostController,
  setCustomDomainController,
  updateBrandingController,
  uploadLogoDirectController,
  verifyCustomDomainController,
} from '../controllers/branding.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requirePortalScope } from '../middleware/portal.middleware.js';

/**
 * Raw body for the logo itself.
 *
 * `express.raw` rather than `json`: the payload is a file, and a JSON parser
 * would either reject it or base64-wrap it. The limit is one byte over the
 * largest accepted logo, so an oversized file is refused here for the reason
 * "too large" instead of arriving whole and being rejected further in.
 */
const logoBody = raw({ limit: '257kb', type: ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'] });


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
 * Storing a logo is a paid capability, because it puts an asset on a client
 * facing page.
 *
 * Two paths exist. `logo/upload` issues a presigned URL for the browser to PUT
 * to directly, which keeps file bytes off this server entirely. `logo/store`
 * takes the bytes here and writes them, and is what the console uses: the
 * direct path turned out to depend on a browser reproducing a signature exactly,
 * and when it did not the operator saw "Failed to fetch" with nothing on this
 * server to diagnose it from.
 */
brandingRouter.post(
  '/workspaces/:organizationId/branding/logo/store',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('branding.logoUpload'),
  logoBody,
  uploadLogoDirectController,
);

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
