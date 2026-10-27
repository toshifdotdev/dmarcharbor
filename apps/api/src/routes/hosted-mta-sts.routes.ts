import express, { Router } from 'express';
import {
  checkHostedMtaStsController,
  getHostedMtaStsController,
  releaseHostedMtaStsController,
  startHostedMtaStsController,
  updateHostedMtaStsController,
} from '../controllers/hosted-mta-sts.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { dnsPublishRateLimiter } from '../middleware/rate-limit.middleware.js';

const json = express.json({ limit: '16kb' });

/**
 * Hosted MTA-STS.
 *
 * Starting, changing and every policy edit are the paid feature. Reading,
 * checking and releasing are not gated: a downgraded workspace keeps being
 * served, and must always be able to leave — which for MTA-STS means publishing
 * a `none` policy, not simply deleting a record.
 */
export const hostedMtaStsRouter = Router();

hostedMtaStsRouter.get(
  '/workspaces/:organizationId/domains/:domainId/hosted-mta-sts',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  getHostedMtaStsController,
);

hostedMtaStsRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-mta-sts',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hostedMtaSts'),
  dnsPublishRateLimiter,
  startHostedMtaStsController,
);

hostedMtaStsRouter.put(
  '/workspaces/:organizationId/domains/:domainId/hosted-mta-sts',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hostedMtaSts'),
  dnsPublishRateLimiter,
  json,
  updateHostedMtaStsController,
);

hostedMtaStsRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-mta-sts/check',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  checkHostedMtaStsController,
);

hostedMtaStsRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-mta-sts/release',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  releaseHostedMtaStsController,
);
