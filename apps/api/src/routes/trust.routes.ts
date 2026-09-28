import { Router } from 'express';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import {
  createTrustCenterController,
  publicTrustCenterController,
  revokeTrustCenterController,
  trustCenterStatusController,
} from '../controllers/trust.controller.js';

export const trustRouter = Router();

/**
 * Public and unauthenticated by design. The recipient is an auditor at the
 * client's own organisation, opening a link their IT provider forwarded. It
 * carries no session and asks for none, and the unguessable slug is the only
 * protection, so rotating the slug withdraws the page immediately.
 */
trustRouter.get('/trust/:slug', publicTrustCenterController);

trustRouter.get(
  '/workspaces/:organizationId/clients/:clientId/trust-center',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  trustCenterStatusController,
);

trustRouter.post(
  '/workspaces/:organizationId/clients/:clientId/trust-center',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  // Creating the link publishes a claim about this client's data, so it is a
  // paid capability rather than a free toggle.
  requireFeature('trust.center'),
  createTrustCenterController,
);

trustRouter.delete(
  '/workspaces/:organizationId/clients/:clientId/trust-center',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  revokeTrustCenterController,
);
