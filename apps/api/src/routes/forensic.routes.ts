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
import { createReportIngestRateLimiter } from '../middleware/rate-limit.middleware.js';

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
  // Collection has to write a DMARC record. Gating on reports.forensicNamed
  // instead, as the identity route does, let a Mooring workspace turn forensic
  // collection on for a domain it cannot then list or ingest into.
  requireFeature('reports.forensic'),
  forensicJsonParser,
  setForensicCollectionController,
);
forensicRouter.post(
  '/workspaces/:organizationId/domains/:domainId/forensics',
  requireSession,
  requireOrganizationPermission('forensic', 'ingest'),
  requireFeature('reports.forensic'),
  forensicJsonParser,
  createReportIngestRateLimiter(),
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
  // Purging destroys the evidence a report exists to produce, so it is gated on
  // the same licence as reading it. A role check alone let any workspace with
  // the purge permission destroy reports it was not entitled to collect.
  requireFeature('reports.forensic'),
  purgeForensicsController,
);
forensicRouter.get(
  '/workspaces/:organizationId/forensics/:forensicId',
  requireSession,
  requireOrganizationPermission('forensic', 'read'),
  requireFeature('reports.forensic'),
  getForensicReportController,
);
forensicRouter.delete(
  '/workspaces/:organizationId/forensics/:forensicId',
  requireSession,
  requireOrganizationPermission('forensic', 'purge'),
  requireFeature('reports.forensic'),
  deleteForensicReportController,
);
