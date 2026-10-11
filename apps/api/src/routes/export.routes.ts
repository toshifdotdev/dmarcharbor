import { Router } from 'express';
import {
  createExportController,
  downloadExportController,
  getExportController,
  listExportsController,
  revokeExportController,
} from '../controllers/export.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const exportRouter = Router();

exportRouter.post(
  '/workspaces/:organizationId/exports',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  createExportController,
);
exportRouter.get(
  '/workspaces/:organizationId/exports',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  listExportsController,
);
exportRouter.get(
  '/workspaces/:organizationId/exports/:exportId',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  getExportController,
);
exportRouter.get(
  '/workspaces/:organizationId/exports/:exportId/download',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  downloadExportController,
);
/**
 * Delete is gated on `report: update`, not `report: read`.
 *
 * Revoking is destructive: it nulls the token and every link already emailed to
 * the customer stops working. `read` is the permission a viewer holds, so a
 * member who could only look at reports could end another member's export.
 */
exportRouter.delete(
  '/workspaces/:organizationId/exports/:exportId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  revokeExportController,
);
