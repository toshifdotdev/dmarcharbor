import { Router } from 'express';
import {
  configureTeamsDestinationController,
  deleteTeamsDestinationController,
  getTeamsDestinationController,
  setTeamsDestinationEnabledController,
  testTeamsDestinationController,
} from '../controllers/teams.controller.js';
import { teamsDestinations } from '../controllers/chat-destinations.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { onlyDisables, requireFeature, requireFeatureUnless } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { teamsTestRateLimiter } from '../middleware/rate-limit.middleware.js';

/**
 * Microsoft Teams alerts.
 *
 * Gated on `alerts.email`, as Slack is: one key covers every alert channel, so
 * Teams starts on Fairway, which is what the pricing page says. This router used
 * to carry no gate while delivery was gated, so a free workspace could save a
 * channel that never received an alert, and the test button posted a real
 * message to Microsoft from a plan that does not include the feature.
 *
 * Saving a channel, switching it back on and sending a test are the paid part.
 * Reading it, pausing it and removing it stay open on every plan, so a
 * destination kept after a downgrade can still be seen and taken away.
 *
 * `requireSession` is applied per route, never as `router.use(...)`. This router
 * is mounted at /api, so it sees every /api request; a `use` here would put an
 * authentication requirement in front of every router mounted after it. That
 * mistake shipped once already, which is why the comment is repeated.
 */
export const teamsRouter = Router();

teamsRouter.get(
  '/workspaces/:organizationId/teams-destination',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  getTeamsDestinationController,
);

teamsRouter.put(
  '/workspaces/:organizationId/teams-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('alerts.email'),
  configureTeamsDestinationController,
);

teamsRouter.patch(
  '/workspaces/:organizationId/teams-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  // Pausing ({ enabled: false }) is open on every plan; switching it back on is not.
  requireFeatureUnless('alerts.email', onlyDisables),
  setTeamsDestinationEnabledController,
);

teamsRouter.delete(
  '/workspaces/:organizationId/teams-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  deleteTeamsDestinationController,
);

teamsRouter.post(
  '/workspaces/:organizationId/teams-destination/test',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  // Before the limiter, so a refused test does not spend the five a minute.
  requireFeature('alerts.email'),
  teamsTestRateLimiter,
  testTeamsDestinationController,
);

/**
 * Several channels, each routed by client and kind (chat-destinations
 * controller). The same gates as the single-destination routes above: adding,
 * changing and testing need alerts.email; reading, pausing and removing are
 * open on every plan.
 */
teamsRouter.get(
  '/workspaces/:organizationId/teams-destinations',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  teamsDestinations.list,
);

teamsRouter.post(
  '/workspaces/:organizationId/teams-destinations',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('alerts.email'),
  teamsDestinations.create,
);

teamsRouter.patch(
  '/workspaces/:organizationId/teams-destinations/:destinationId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeatureUnless('alerts.email', onlyDisables),
  teamsDestinations.update,
);

teamsRouter.delete(
  '/workspaces/:organizationId/teams-destinations/:destinationId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  teamsDestinations.remove,
);

teamsRouter.post(
  '/workspaces/:organizationId/teams-destinations/:destinationId/test',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('alerts.email'),
  teamsTestRateLimiter,
  teamsDestinations.test,
);