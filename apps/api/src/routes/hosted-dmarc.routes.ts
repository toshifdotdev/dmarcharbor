import express, { Router } from 'express';
import {
  checkHostedDmarcController,
  getHostedDmarcController,
  releaseHostedDmarcController,
  restoreHostedDmarcController,
  startHostedDmarcController,
  updateHostedDmarcController,
} from '../controllers/hosted-dmarc.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { dnsPublishRateLimiter } from '../middleware/rate-limit.middleware.js';

const json = express.json({ limit: '16kb' });

/**
 * Hosted DMARC records.
 *
 * Starting, changing and restoring are the paid feature. Reading and releasing
 * are not gated: a downgraded workspace must still be able to see what it has
 * and leave the arrangement.
 */
export const hostedDmarcRouter = Router();

hostedDmarcRouter.get(
  '/workspaces/:organizationId/domains/:domainId/hosted-dmarc',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  getHostedDmarcController,
);

hostedDmarcRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-dmarc',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hosted'),
  dnsPublishRateLimiter,
  startHostedDmarcController,
);

hostedDmarcRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-dmarc/check',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  checkHostedDmarcController,
);

hostedDmarcRouter.put(
  '/workspaces/:organizationId/domains/:domainId/hosted-dmarc',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hosted'),
  dnsPublishRateLimiter,
  json,
  updateHostedDmarcController,
);

hostedDmarcRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-dmarc/changes/:changeId/restore',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hosted'),
  json,
  restoreHostedDmarcController,
);

hostedDmarcRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-dmarc/release',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  releaseHostedDmarcController,
);
