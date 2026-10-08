import { Router } from 'express';
import {
  createDomainScanController,
  getScanController,
  listDomainScansController,
} from '../controllers/domain-scan.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { createScanRateLimiter } from '../middleware/rate-limit.middleware.js';

export const domainScanRouter = Router();

domainScanRouter.post(
  '/workspaces/:organizationId/domains/:domainId/scans',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  createScanRateLimiter(),
  createDomainScanController,
);
domainScanRouter.get(
  '/workspaces/:organizationId/domains/:domainId/scans',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  listDomainScansController,
);
domainScanRouter.get(
  '/workspaces/:organizationId/scans/:scanId',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  getScanController,
);
