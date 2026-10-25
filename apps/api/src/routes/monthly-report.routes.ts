import { Router } from 'express';
import {
  deleteMonthlyReportScheduleController,
  downloadMonthlyReportController,
  getMonthlyReportScheduleController,
  issueMonthlyReportController,
  listMonthlyReportsController,
  publicMonthlyReportDownloadController,
  putMonthlyReportScheduleController,
} from '../controllers/monthly-report.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import {
  monthlyReportIssueRateLimiter,
  publicMonthlyReportDownloadRateLimiter,
} from '../middleware/rate-limit.middleware.js';

export const monthlyReportRouter = Router();

monthlyReportRouter.get(
  '/workspaces/:organizationId/clients/:clientId/monthly-reports',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  requireFeature('reports.compliancePack'),
  listMonthlyReportsController,
);

monthlyReportRouter.post(
  '/workspaces/:organizationId/clients/:clientId/monthly-reports',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  requireFeature('reports.compliancePack'),
  monthlyReportIssueRateLimiter,
  issueMonthlyReportController,
);

monthlyReportRouter.get(
  '/workspaces/:organizationId/clients/:clientId/monthly-reports/:reportId/download',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  requireFeature('reports.compliancePack'),
  downloadMonthlyReportController,
);

monthlyReportRouter.get(
  '/workspaces/:organizationId/clients/:clientId/monthly-report-schedule',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  requireFeature('reports.compliancePack'),
  getMonthlyReportScheduleController,
);

monthlyReportRouter.put(
  '/workspaces/:organizationId/clients/:clientId/monthly-report-schedule',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  requireFeature('reports.compliancePack'),
  putMonthlyReportScheduleController,
);

monthlyReportRouter.delete(
  '/workspaces/:organizationId/clients/:clientId/monthly-report-schedule',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  requireFeature('reports.compliancePack'),
  deleteMonthlyReportScheduleController,
);

/** Public by design: the recipient opens it from an email with no account here. */
monthlyReportRouter.get(
  '/monthly-reports/download',
  publicMonthlyReportDownloadRateLimiter,
  publicMonthlyReportDownloadController,
);
