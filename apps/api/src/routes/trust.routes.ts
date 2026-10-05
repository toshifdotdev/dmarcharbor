import { Router } from 'express';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { compliancePackVerifyRateLimiter as publicVerifierRateLimiter } from '../middleware/rate-limit.middleware.js';
import {
  createTrustCenterController,
  publicTrustCenterController,
  revokeTrustCenterController,
  trustCenterStatusController,
} from '../controllers/trust.controller.js';
import {
  createCompliancePackController,
  listCompliancePacksController,
  verifyCompliancePackController,
} from '../controllers/compliance-pack.controller.js';

export const trustRouter = Router();

/**
 * Public and unauthenticated by design. The recipient is an auditor at the
 * client's own organisation, opening a link their IT provider forwarded. It
 * carries no session and asks for none, and the unguessable slug is the only
 * protection, so rotating the slug withdraws the page immediately.
 */
trustRouter.get('/trust/:slug', publicTrustCenterController);

/**
 * Public and unauthenticated, because the person verifying a pack is an auditor
 * at the client's organisation with the file in hand and no account here. It
 * answers only about a fingerprint.
 *
 * Deliberately not under /trust/:slug. A sibling route there would be captured
 * by the slug parameter, and a literal path that loses to a wildcard is the kind
 * of thing that only shows up as a confusing 404 in production.
 */
trustRouter.get('/compliance-packs/verify', publicVerifierRateLimiter, verifyCompliancePackController);

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

trustRouter.get(
  '/workspaces/:organizationId/clients/:clientId/compliance-packs',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  listCompliancePacksController,
);

trustRouter.post(
  '/workspaces/:organizationId/clients/:clientId/compliance-packs',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  // Producing the pack publishes a signed claim, so it is a paid capability.
  requireFeature('reports.compliancePack'),
  createCompliancePackController,
);
