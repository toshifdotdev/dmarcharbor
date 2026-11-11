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

/**
 * Every export route is for owners and admins (`organization: read`).
 *
 * They were on `report: read`, which a viewer holds, and an export is not a
 * report view: it carries the forensic reports (named recipients where they
 * are kept), every member's sessions with their IP address and browser, the
 * invitations, the API keys and the audit trail. Session 16 found a viewer,
 * refused the forensic list in the app (403), downloading all of it in the
 * workspace export. The right of access is the data subject's, exercised by
 * the workspace's owner or admin on their behalf; it never meant every staff
 * role may take a copy of everyone else's data. Erasure is guarded the same way.
 */
const canExport = requireOrganizationPermission('organization', 'read');

exportRouter.post('/workspaces/:organizationId/exports', requireSession, canExport, createExportController);
exportRouter.get('/workspaces/:organizationId/exports', requireSession, canExport, listExportsController);
exportRouter.get('/workspaces/:organizationId/exports/:exportId', requireSession, canExport, getExportController);
exportRouter.get('/workspaces/:organizationId/exports/:exportId/download', requireSession, canExport, downloadExportController);
/**
 * Revoking stops every link already emailed, so it stays with the same people
 * who can request one.
 */
exportRouter.delete('/workspaces/:organizationId/exports/:exportId', requireSession, canExport, revokeExportController);
