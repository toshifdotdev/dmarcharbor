import { Router } from 'express';
import {
  configureSlackDestinationController,
  deleteSlackDestinationController,
  getSlackDestinationController,
  setSlackDestinationEnabledController,
  testSlackDestinationController,
} from '../controllers/slack.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { slackTestRateLimiter } from '../middleware/rate-limit.middleware.js';
import { onlyDisables, requireFeature, requireFeatureUnless } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

/**
 * Slack alerts.
 *
 * Gated on `alerts.email`, the one key behind every alert channel, so Slack
 * starts on Fairway with email and Teams, which is what the pricing page says.
 * This router used to carry no gate, on the reasoning that a chat channel is
 * only a second copy of an email alert. But delivery was always gated: alert
 * rules, DNS-change and domain-expiry notices are only produced on a plan with
 * `alerts.email`. So a free workspace could save a channel that never received
 * anything, which read as a broken integration rather than a plan boundary.
 *
 * Saving a channel and switching it back on are the paid part. Reading it,
 * pausing it and removing it stay open on every plan, so a destination kept
 * after a downgrade can still be seen and taken away, the same rule as a kept
 * webhook, mailbox or PSA connection.
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
  requireFeature('alerts.email'),
  configureSlackDestinationController,
);

slackRouter.patch(
  '/workspaces/:organizationId/slack-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  // Pausing ({ enabled: false }) is open on every plan; switching it back on is not.
  requireFeatureUnless('alerts.email', onlyDisables),
  setSlackDestinationEnabledController,
);

slackRouter.delete(
  '/workspaces/:organizationId/slack-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  deleteSlackDestinationController,
);

slackRouter.post(
  '/workspaces/:organizationId/slack-destination/test',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  // Before the limiter, so a refused test does not spend the five a minute.
  requireFeature('alerts.email'),
  slackTestRateLimiter,
  testSlackDestinationController,
);