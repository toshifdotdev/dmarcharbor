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
import { requireStaff } from '../middleware/staff.middleware.js';
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
/**
 * Plan changes are a support operation, not a workspace one.
 *
 * This used to be reachable by any member holding billing:update, which the
 * owner role has, so a workspace owner could grant themselves Admiralty with no
 * charge and no provider record. A plan is what money buys, so the route is
 * authorised by the staff credential instead and the workspace session is no
 * longer consulted for it at all.
 */
entitlementRouter.patch(
  '/workspaces/:organizationId/plan',
  requireStaff,
  changePlanController,
);
/**
 * Overrides bypass the plan entirely, so they take the same staff credential
 * as the plan change itself. Left on billing:update it was the same hole one
 * route over: an owner could grant themselves the entitlement they were about
 * to be refused.
 */
entitlementRouter.post(
  '/workspaces/:organizationId/entitlement-overrides',
  requireStaff,
  setOverrideController,
);
entitlementRouter.delete(
  '/workspaces/:organizationId/entitlement-overrides/:entitlement',
  requireStaff,
  removeOverrideController,
);
