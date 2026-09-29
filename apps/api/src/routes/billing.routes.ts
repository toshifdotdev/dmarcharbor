import { Router } from 'express';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireStaff } from '../middleware/staff.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import {
  billingPortalController,
  billingStatusController,
  cancelSubscriptionController,
  changePlanController,
  planSyncStatusController,
  paddleWebhookController,
  razorpayWebhookController,
  reconcileController,
  resumeSubscriptionController,
  startCheckoutController,
} from '../controllers/billing.controller.js';

export const billingRouter = Router();

/**
 * Payment webhooks are mounted before any session or JSON body middleware.
 *
 * The signature is computed over the exact bytes the provider sent, so the body
 * must be captured raw and never re-serialised. A route that runs after
 * `express.json()` has already parsed it can only see a reserialised object, and
 * verification then fails intermittently.
 */
billingRouter.post('/webhooks/razorpay', razorpayWebhookController);
billingRouter.post('/webhooks/paddle', paddleWebhookController);

billingRouter.get(
  '/workspaces/:organizationId/billing',
  requireSession,
  requireOrganizationPermission('billing', 'read'),
  billingStatusController,
);

billingRouter.post(
  '/workspaces/:organizationId/billing/checkout',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  startCheckoutController,
);

billingRouter.patch(
  '/workspaces/:organizationId/billing/plan',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  changePlanController,
);

billingRouter.post(
  '/workspaces/:organizationId/billing/cancel',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  cancelSubscriptionController,
);

billingRouter.post(
  '/workspaces/:organizationId/billing/resume',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  resumeSubscriptionController,
  reconcileController,
);

billingRouter.post(
  '/workspaces/:organizationId/billing/portal',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  billingPortalController,
);

/**
 * On demand reconciliation.
 *
 * Staff only, on the same credential as plan changes, because it makes outbound
 * provider calls. Not a workspace route: no workspace role should be able to
 * make the service sweep every customer's billing state.
 */
billingRouter.post('/billing/reconcile', requireStaff, reconcileController);

/** Operator only: reports which provider plans still need creating. */
billingRouter.get(
  '/workspaces/:organizationId/billing/plan-sync',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  planSyncStatusController,
);
