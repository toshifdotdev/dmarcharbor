import { Router } from 'express';
import {
  getTlsReportController,
  listTlsReportsController,
  tlsReportSummaryController,
} from '../controllers/tls-report.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

/**
 * TLS-RPT reports are collected on every plan, but reading them is a Fairway
 * feature. Every route is therefore both workspace-scoped and feature-gated;
 * the intake path is deliberately not here.
 */
export const tlsReportRouter = Router();

tlsReportRouter.get(
  '/workspaces/:organizationId/domains/:domainId/tls-reports',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  requireFeature('reports.tlsrpt'),
  listTlsReportsController,
);

tlsReportRouter.get(
  '/workspaces/:organizationId/domains/:domainId/tls-reports/summary',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  requireFeature('reports.tlsrpt'),
  tlsReportSummaryController,
);

tlsReportRouter.get(
  '/workspaces/:organizationId/tls-reports/:reportId',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  requireFeature('reports.tlsrpt'),
  getTlsReportController,
);
