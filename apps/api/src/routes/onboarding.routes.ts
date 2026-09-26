import express, { Router } from 'express';
import {
  createReportShareController,
  dmarcRecordController,
  listReportSharesController,
  onboardingStateController,
  policyReadinessController,
  publicReportController,
  revokeReportShareController,
} from '../controllers/onboarding.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { publicReportRateLimiter } from '../middleware/rate-limit.middleware.js';

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
onboardingRouter.delete(
  '/workspaces/:organizationId/report-shares/:shareId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  revokeReportShareController,
);

export const publicReportRouter = Router();

publicReportRouter.get('/reports/share/:token', publicReportRateLimiter, publicReportController);
