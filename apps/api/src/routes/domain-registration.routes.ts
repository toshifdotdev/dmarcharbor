import { Router, type Request, type Response } from 'express';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { getDomainRegistration } from '../services/monitoring/domain-expiry.service.js';

/**
 * A domain's registration expiry, as the registry last reported it.
 *
 * On every plan: the date is public registry data and knowing it costs the
 * workspace nothing. Only the warnings (email, chat, in-app) are the alerts
 * feature. `registration: null` means the domain has not been looked up yet.
 */
export const domainRegistrationRouter = Router();

domainRegistrationRouter.get(
  '/workspaces/:organizationId/domains/:domainId/registration',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  async (request: Request, response: Response) => {
    const view = await getDomainRegistration(
      String(request.params.organizationId),
      String(request.params.domainId),
    );
    if (view === undefined) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That domain is not in this workspace.' } });
      return;
    }
    response.json({ registration: view });
  },
);
