import { Router } from 'express';
import {
  configureTeamsDestinationController,
  deleteTeamsDestinationController,
  getTeamsDestinationController,
  setTeamsDestinationEnabledController,
  testTeamsDestinationController,
} from '../controllers/teams.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { teamsTestRateLimiter } from '../middleware/rate-limit.middleware.js';

/**
 * Microsoft Teams alerts.
 *
 * Not behind an entitlement gate, for the same reason as Slack: this is the
 * alert the workspace already receives by email, delivered to a channel its team
 * watches. Charging again for one message would be a second price for the same
 * notification. Webhooks are the different case — they are an integration
 * surface, not a copy of an alert.
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
  configureTeamsDestinationController,
);

teamsRouter.patch(
  '/workspaces/:organizationId/teams-destination',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
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
  teamsTestRateLimiter,
  testTeamsDestinationController,
);
