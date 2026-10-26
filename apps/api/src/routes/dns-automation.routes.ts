import express, { Router } from 'express';
import {
  createDnsConnectionController,
  deleteDnsConnectionController,
  listDnsConnectionsController,
  previewDnsController,
  publishDnsController,
  restoreDnsController,
} from '../controllers/dns-automation.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { dnsPublishRateLimiter } from '../middleware/rate-limit.middleware.js';

const json = express.json({ limit: '16kb' });

/**
 * Cloudflare DNS publishing.
 *
 * Creating a connection, previewing, publishing and restoring are the paid
 * feature. Listing and removing a connection are deliberately not gated, so a
 * workspace that downgrades can see what it configured and remove the stored
 * credential. Publishing is refused with the standard 402 until the plan grants
 * it again.
 */
export const dnsAutomationRouter = Router();

dnsAutomationRouter.get(
  '/workspaces/:organizationId/dns-connections',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  listDnsConnectionsController,
);

dnsAutomationRouter.post(
  '/workspaces/:organizationId/dns-connections',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('dns.automation'),
  json,
  createDnsConnectionController,
);

dnsAutomationRouter.delete(
  '/workspaces/:organizationId/dns-connections/:connectionId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  deleteDnsConnectionController,
);

dnsAutomationRouter.post(
  '/workspaces/:organizationId/domains/:domainId/dns-publish/preview',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.automation'),
  json,
  previewDnsController,
);

dnsAutomationRouter.post(
  '/workspaces/:organizationId/domains/:domainId/dns-publish',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.automation'),
  dnsPublishRateLimiter,
  json,
  publishDnsController,
);

dnsAutomationRouter.post(
  '/workspaces/:organizationId/dns-publications/:publicationId/restore',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.automation'),
  restoreDnsController,
);
