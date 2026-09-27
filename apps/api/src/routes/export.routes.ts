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
exportRouter.delete(
  '/workspaces/:organizationId/exports/:exportId',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  revokeExportController,
);
