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

const alertJsonParser = express.json({ limit: '64kb' });

export const alertRouter = Router();

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
  alertJsonParser,
  updateAlertRuleController,
);
alertRouter.delete(
  '/workspaces/:organizationId/alert-rules/:ruleId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
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
