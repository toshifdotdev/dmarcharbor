import { Router } from 'express';
import {
  createSsoConnectionController,
  deleteSsoConnectionController,
  listSsoConnectionsController,
  ssoCallbackController,
  ssoInfoController,
  ssoStartController,
} from '../controllers/sso.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';

export const ssoRouter = Router();

/** Settings. The agency managing its own identity provider. */
ssoRouter.get(
  '/workspaces/:organizationId/sso-connections',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  requireFeature('auth.sso'),
  listSsoConnectionsController,
);

ssoRouter.post(
  '/workspaces/:organizationId/sso-connections',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('auth.sso'),
  createSsoConnectionController,
);

ssoRouter.delete(
  '/workspaces/:organizationId/sso-connections/:connectionId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('auth.sso'),
  deleteSsoConnectionController,
);

/**
 * The sign in endpoints, deliberately outside the session middleware.
 *
 * A user arriving back from the customer's identity provider has no session,
 * because they have not signed in yet. Requiring one would make the flow
 * impossible, and requiring nothing else is correct: the state parameter ties the
 * callback to a request this server started, and the provider's signature or
 * token is what proves who the person is.
 *
 * The entitlement gate is not applied here on purpose. It gates who may
 * *configure* a connection, and a connection can only exist if it was configured
 * by someone who passed that gate, so applying it again would only make an
 * existing configuration unreachable if a workspace later downgraded. Access is
 * still bounded by the connection's own email domain allowlist, which is checked
 * before any account is created.
 */
ssoRouter.get('/sso/:connectionId', ssoInfoController);
ssoRouter.get('/sso/:connectionId/start', ssoStartController);
ssoRouter.get('/sso/:connectionId/callback', ssoCallbackController);
ssoRouter.post('/sso/:connectionId/saml/acs', ssoCallbackController);
