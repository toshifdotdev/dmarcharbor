import { Router } from 'express';
import {
  cancelErasureController,
  executeErasureController,
  getErasureController,
  listErasuresController,
  previewErasureController,
  requestErasureController,
} from '../controllers/erasure.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const erasureRouter = Router();

erasureRouter.get(
  '/workspaces/:organizationId/erasures/preview',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  previewErasureController,
);
erasureRouter.post(
  '/workspaces/:organizationId/erasures',
  requireSession,
  requireOrganizationPermission('organization', 'delete'),
  requestErasureController,
);
erasureRouter.get(
  '/workspaces/:organizationId/erasures',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  listErasuresController,
);
erasureRouter.get(
  '/workspaces/:organizationId/erasures/:erasureId',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  getErasureController,
);
erasureRouter.post(
  '/workspaces/:organizationId/erasures/:erasureId/cancel',
  requireSession,
  requireOrganizationPermission('organization', 'delete'),
  cancelErasureController,
);
erasureRouter.post(
  '/workspaces/:organizationId/erasures/:erasureId/execute',
  requireSession,
  requireOrganizationPermission('organization', 'delete'),
  executeErasureController,
);
