import express, { Router } from 'express';
import {
  acknowledgeAlertEventController,
  createAlertRuleController,
  deleteAlertRuleController,
  getNotificationPreferenceController,
  listAlertEventsController,
  listAlertRulesController,
  updateAlertRuleController,
  updateNotificationPreferenceController,
} from '../controllers/alert.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';

const alertJsonParser = express.json({ limit: '64kb' });

export const alertRouter = Router();

/**
 * Updating and deleting a rule is gated here.
 *
 * Creation was already enforced: `createAlertRuleController` calls
 * `assertFeature` itself, which is the better place for it, because spoofing
 * detection is a separate licence from plain email alerts and only the parsed
 * body says which one a rule is for. That check is metric-aware; this middleware
 * is not, so it would refuse a spoofing rule on a plan that has spoofing but not
 * plain email alerts.
 *
 * So the real gap was narrower than it looked: update and delete had no check at
 * all. A workspace that paid, created rules and then downgraded could still
 * rewrite and delete them. Reads stay open for the same reason as before, a
 * downgraded workspace must still see what it earned.
 */
alertRouter.post(
  '/workspaces/:organizationId/alert-rules',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  alertJsonParser,
  createAlertRuleController,
);
alertRouter.get(
  '/workspaces/:organizationId/alert-rules',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  listAlertRulesController,
);
alertRouter.patch(
  '/workspaces/:organizationId/alert-rules/:ruleId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  requireFeature('alerts.email'),
  alertJsonParser,
  updateAlertRuleController,
);
alertRouter.delete(
  '/workspaces/:organizationId/alert-rules/:ruleId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  requireFeature('alerts.email'),
  deleteAlertRuleController,
);
alertRouter.get(
  '/workspaces/:organizationId/alerts',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  listAlertEventsController,
);
alertRouter.post(
  '/workspaces/:organizationId/alerts/:eventId/acknowledge',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  acknowledgeAlertEventController,
);
alertRouter.get(
  '/me/:userId/notification-preferences',
  requireSession,
  getNotificationPreferenceController,
);
alertRouter.patch(
  '/me/:userId/notification-preferences',
  requireSession,
  alertJsonParser,
  updateNotificationPreferenceController,
);
