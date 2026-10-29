import { Router } from 'express';
import { usageExportController } from '../controllers/usage-export.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const usageExportRouter = Router();

/**
 * GET /workspaces/:id/usage?month=YYYY-MM&format=csv|json
 *
 * `billing: read`, not `report: read`: the export is a workspace-wide figure
 * an agency bills from, and a client contact (the portal role, which can read
 * reports) must not be able to pull every other client's volumes. The plan
 * gate (reports.usageExport) is in the controller, so the refusal carries the
 * same body as every other one.
 */
usageExportRouter.get(
  '/workspaces/:organizationId/usage',
  requireSession,
  requireOrganizationPermission('billing', 'read'),
  usageExportController,
);
