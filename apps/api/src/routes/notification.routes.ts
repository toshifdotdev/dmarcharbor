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
import { onlyDisables, requireFeatureUnless } from '../middleware/entitlement.middleware.js';
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
/**
 * Editing a digest is the paid feature; pausing one is not.
 *
 * This route had no gate, so a workspace below Harbor could rewrite a kept
 * digest's recipients, schedule and contents, and switch it back on, which is
 * configuring the feature rather than keeping it. `{ enabled: false }` on its
 * own stays open on every plan, as do reading and removing, so a downgraded
 * workspace can always stop and clear what it set up. Placed after the parser
 * because the exemption reads the body.
 */
notificationRouter.patch(
  '/workspaces/:organizationId/report-digests/:digestId',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  notificationJsonParser,
  requireFeatureUnless('digests', onlyDisables),
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
