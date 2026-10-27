import express, { Router } from 'express';
import {
  checkManagedSpfController,
  getManagedSpfController,
  previewManagedSpfController,
  releaseManagedSpfController,
  startManagedSpfController,
  updateManagedSpfController,
} from '../controllers/managed-spf.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import {
  createScanRateLimiter,
  dnsPublishRateLimiter,
} from '../middleware/rate-limit.middleware.js';

const json = express.json({ limit: '32kb' });
const previewRateLimiter = createScanRateLimiter();

/**
 * Managed SPF.
 *
 * Starting, previewing, saving and checking are the paid feature. Reading and
 * releasing are not gated: a downgraded workspace must still see the record it
 * keeps serving and be able to leave. The refresh job keeps running on its own.
 */
export const managedSpfRouter = Router();

managedSpfRouter.get(
  '/workspaces/:organizationId/domains/:domainId/managed-spf',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  getManagedSpfController,
);

managedSpfRouter.post(
  '/workspaces/:organizationId/domains/:domainId/managed-spf',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.managedSpf'),
  dnsPublishRateLimiter,
  startManagedSpfController,
);

managedSpfRouter.post(
  '/workspaces/:organizationId/domains/:domainId/managed-spf/preview',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.managedSpf'),
  previewRateLimiter,
  json,
  previewManagedSpfController,
);

managedSpfRouter.put(
  '/workspaces/:organizationId/domains/:domainId/managed-spf',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.managedSpf'),
  dnsPublishRateLimiter,
  json,
  updateManagedSpfController,
);

managedSpfRouter.post(
  '/workspaces/:organizationId/domains/:domainId/managed-spf/check',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  checkManagedSpfController,
);

managedSpfRouter.post(
  '/workspaces/:organizationId/domains/:domainId/managed-spf/release',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  releaseManagedSpfController,
);
