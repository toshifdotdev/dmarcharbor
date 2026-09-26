import express, { Router } from 'express';
import {
  createReportDigestController,
  deleteReportDigestController,
  listNotificationsController,
  listReportDigestsController,
  markAllNotificationsReadController,
  markNotificationReadController,
  portfolioOnboardingController,
  runDigestsNowController,
  sendReportDigestController,
  unreadCountController,
  updateReportDigestController,
} from '../controllers/notification.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

const notificationJsonParser = express.json({ limit: '16kb' });

export const notificationRouter = Router();

notificationRouter.get('/me/notifications', requireSession, listNotificationsController);
notificationRouter.get('/me/notifications/unread-count', requireSession, unreadCountController);
notificationRouter.post('/me/notifications/read-all', requireSession, markAllNotificationsReadController);
notificationRouter.post(
  '/me/notifications/:notificationId/read',
  requireSession,
  markNotificationReadController,
);
notificationRouter.get(
  '/workspaces/:organizationId/onboarding',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  portfolioOnboardingController,
);
notificationRouter.post(
  '/workspaces/:organizationId/report-digests',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  notificationJsonParser,
  createReportDigestController,
);
notificationRouter.get(
  '/workspaces/:organizationId/report-digests',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  listReportDigestsController,
);
notificationRouter.patch(
  '/workspaces/:organizationId/report-digests/:digestId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  notificationJsonParser,
  updateReportDigestController,
);
notificationRouter.delete(
  '/workspaces/:organizationId/report-digests/:digestId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  deleteReportDigestController,
);
notificationRouter.post(
  '/workspaces/:organizationId/report-digests/:digestId/send',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  sendReportDigestController,
);
notificationRouter.post(
  '/workspaces/:organizationId/report-digests/run',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  runDigestsNowController,
);
