import express, { Router } from 'express';
import {
  createReportShareController,
  deleteAllRevokedReportSharesController,
  deleteReportShareController,
  dmarcRecordController,
  listReportSharesController,
  onboardingStateController,
  policyReadinessController,
  publicReportController,
  revokeReportShareController,
} from '../controllers/onboarding.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { createPublicReportRateLimiter } from '../middleware/rate-limit.middleware.js';
import {
  bulkReviewSendersController,
  reviewSenderController,
  senderBreakdownController,
  setSenderOwnerController,
} from '../controllers/sender.controller.js';
import { dismissSubdomainController, listSubdomainsController } from '../controllers/subdomain.controller.js';

const onboardingJsonParser = express.json({ limit: '16kb' });

export const onboardingRouter = Router();

onboardingRouter.get(
  '/workspaces/:organizationId/domains/:domainId/onboarding',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  onboardingStateController,
);
onboardingRouter.get(
  '/workspaces/:organizationId/domains/:domainId/dmarc-record',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  dmarcRecordController,
);
onboardingRouter.get(
  '/workspaces/:organizationId/domains/:domainId/senders',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  senderBreakdownController,
);
onboardingRouter.put(
  '/workspaces/:organizationId/domains/:domainId/senders/review',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  onboardingJsonParser,
  reviewSenderController,
);
onboardingRouter.put(
  '/workspaces/:organizationId/domains/:domainId/senders/owner',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('senders.owners'),
  onboardingJsonParser,
  setSenderOwnerController,
);
onboardingRouter.get(
  '/workspaces/:organizationId/domains/:domainId/subdomains',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  listSubdomainsController,
);
onboardingRouter.put(
  '/workspaces/:organizationId/domains/:domainId/subdomains/dismissal',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  onboardingJsonParser,
  dismissSubdomainController,
);
onboardingRouter.put(
  '/workspaces/:organizationId/clients/:clientId/senders/review',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  onboardingJsonParser,
  bulkReviewSendersController,
);
onboardingRouter.get(
  '/workspaces/:organizationId/domains/:domainId/policy-readiness',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  policyReadinessController,
);
onboardingRouter.post(
  '/workspaces/:organizationId/report-shares',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  onboardingJsonParser,
  createReportShareController,
);
onboardingRouter.get(
  '/workspaces/:organizationId/report-shares',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  listReportSharesController,
);
/**
 * Residue cleanup, declared BEFORE `/:shareId`.
 *
 * Express matches in registration order, so with these below the parameter route
 * "revoked" is read as a share id and the call 404s for a share that does not
 * exist. The same mistake on the portal routes shipped once already.
 */
onboardingRouter.delete(
  '/workspaces/:organizationId/report-shares/revoked',
  requireSession,
  requireOrganizationPermission('report', 'delete'),
  deleteAllRevokedReportSharesController,
);
onboardingRouter.delete(
  '/workspaces/:organizationId/report-shares/:shareId/permanent',
  requireSession,
  requireOrganizationPermission('report', 'delete'),
  deleteReportShareController,
);
onboardingRouter.delete(
  '/workspaces/:organizationId/report-shares/:shareId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  revokeReportShareController,
);

export const publicReportRouter = Router();

publicReportRouter.get('/reports/share/:token', createPublicReportRateLimiter(), publicReportController);
