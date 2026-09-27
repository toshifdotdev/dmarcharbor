import express, { Router } from 'express';
import {
  deleteForensicReportController,
  getForensicReportController,
  ingestForensicReportController,
  listForensicsController,
  purgeForensicsController,
  setForensicCollectionController,
  setForensicIdentityController,
} from '../controllers/forensic.controller.js';
import { domainInsightsController } from '../controllers/insights.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { reportIngestRateLimiter } from '../middleware/rate-limit.middleware.js';

const forensicJsonParser = express.json({ limit: '6mb' });

export const forensicRouter = Router();

forensicRouter.get(
  '/workspaces/:organizationId/domains/:domainId/insights',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  domainInsightsController,
);
forensicRouter.patch(
  '/workspaces/:organizationId/domains/:domainId/forensics/identities',
  requireSession,
  requireOrganizationPermission('forensic', 'identify'),
  requireFeature('reports.forensicNamed'),
  forensicJsonParser,
  setForensicIdentityController,
);
forensicRouter.patch(
  '/workspaces/:organizationId/domains/:domainId/forensics',
  requireSession,
  requireOrganizationPermission('forensic', 'ingest'),
  forensicJsonParser,
  setForensicCollectionController,
);
forensicRouter.post(
  '/workspaces/:organizationId/domains/:domainId/forensics',
  requireSession,
  requireOrganizationPermission('forensic', 'ingest'),
  requireFeature('reports.forensic'),
  forensicJsonParser,
  reportIngestRateLimiter,
  ingestForensicReportController,
);
forensicRouter.get(
  '/workspaces/:organizationId/domains/:domainId/forensics',
  requireSession,
  requireOrganizationPermission('forensic', 'read'),
  requireFeature('reports.forensic'),
  listForensicsController,
);
forensicRouter.delete(
  '/workspaces/:organizationId/domains/:domainId/forensics',
  requireSession,
  requireOrganizationPermission('forensic', 'purge'),
  purgeForensicsController,
);
forensicRouter.get(
  '/workspaces/:organizationId/forensics/:forensicId',
  requireSession,
  requireOrganizationPermission('forensic', 'read'),
  getForensicReportController,
);
forensicRouter.delete(
  '/workspaces/:organizationId/forensics/:forensicId',
  requireSession,
  requireOrganizationPermission('forensic', 'purge'),
  deleteForensicReportController,
);
