import { Router } from 'express';
import {
  changePlanController,
  listEntitlementsController,
  listPlanCatalogController,
  planOverviewController,
  removeOverrideController,
  setOverrideController,
} from '../controllers/entitlement.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const entitlementRouter = Router();

entitlementRouter.get('/plans', listPlanCatalogController);
entitlementRouter.get(
  '/workspaces/:organizationId/entitlements',
  requireSession,
  requireOrganizationPermission('billing', 'read'),
  listEntitlementsController,
);
entitlementRouter.get(
  '/workspaces/:organizationId/plan',
  requireSession,
  requireOrganizationPermission('billing', 'read'),
  planOverviewController,
);
entitlementRouter.patch(
  '/workspaces/:organizationId/plan',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  changePlanController,
);
entitlementRouter.post(
  '/workspaces/:organizationId/entitlement-overrides',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  setOverrideController,
);
entitlementRouter.delete(
  '/workspaces/:organizationId/entitlement-overrides/:entitlement',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  removeOverrideController,
);
