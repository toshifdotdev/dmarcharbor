import express, { Router } from 'express';
import {
  getReportController,
  ingestReportController,
  listReportsController,
} from '../controllers/report.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { reportIngestRateLimiter } from '../middleware/rate-limit.middleware.js';

const reportJsonParser = express.json({ limit: '5mb' });

export const reportRouter = Router();

reportRouter.post(
  '/workspaces/:organizationId/domains/:domainId/reports',
  requireSession,
  requireOrganizationPermission('report', 'ingest'),
  reportJsonParser,
  reportIngestRateLimiter,
  ingestReportController,
);
reportRouter.get(
  '/workspaces/:organizationId/domains/:domainId/reports',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  listReportsController,
);
reportRouter.get(
  '/workspaces/:organizationId/reports/:reportId',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  getReportController,
);
