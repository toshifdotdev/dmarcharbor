import { Router } from 'express';
import {
  checkClientSwitchesController,
  checkSwitchController,
  deleteSwitchController,
  getSwitchController,
  importSwitchKitController,
  startSwitchController,
} from '../controllers/switch.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const switchRouter = Router();

switchRouter.post(
  '/workspaces/:organizationId/clients/:clientId/switch-kit',
  requireSession,
  requireOrganizationPermission('domain', 'create'),
  importSwitchKitController,
);
switchRouter.post(
  '/workspaces/:organizationId/clients/:clientId/switch-kit/check',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  checkClientSwitchesController,
);
switchRouter.post(
  '/workspaces/:organizationId/domains/:domainId/switch',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  startSwitchController,
);
switchRouter.get(
  '/workspaces/:organizationId/domains/:domainId/switch',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  getSwitchController,
);
switchRouter.post(
  '/workspaces/:organizationId/domains/:domainId/switch/check',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  checkSwitchController,
);
switchRouter.delete(
  '/workspaces/:organizationId/domains/:domainId/switch',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  deleteSwitchController,
);
