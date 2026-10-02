import { Router } from 'express';
import {
  configureSlackDestinationController,
  deleteSlackDestinationController,
  getSlackDestinationController,
  setSlackDestinationEnabledController,
} from '../controllers/slack.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

/**
 * Slack alerts.
 *
 * Not behind an entitlement gate. This is the same notification an email alert
 * already produces, delivered somewhere the team already watches; putting a chat
 * channel behind a higher plan would be charging twice for one message. Webhook
 * delivery has the same reasoning.
 *
 * `requireSession` is applied per route, not as `router.use(...)`. This router is
 * mounted at /api, so it sees every /api request, and middleware registered with
 * use runs for any request entering the router whether or not one of its own
 * routes matches. Registering the session check that way silently put an
 * authentication requirement in front of every other router mounted after it.
 */
export const slackRouter = Router();

slackRouter.get(
  '/workspaces/:organizationId/slack-destination',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  getSlackDestinationController,
);

slackRouter.put(
  '/workspaces/:organizationId/slack-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  configureSlackDestinationController,
);

slackRouter.patch(
  '/workspaces/:organizationId/slack-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  setSlackDestinationEnabledController,
);

slackRouter.delete(
  '/workspaces/:organizationId/slack-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  deleteSlackDestinationController,
);