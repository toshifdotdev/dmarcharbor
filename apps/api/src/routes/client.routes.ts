import { Router } from 'express';
import {
  bulkCreateDomainsController,
  createClientController,
  createDomainController,
  listClientsController,
  listDomainsController,
  verifyDomainController,
} from '../controllers/client.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireQuota } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const clientRouter = Router();

clientRouter.get(
  '/workspaces/:organizationId/clients',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  listClientsController,
);
clientRouter.post(
  '/workspaces/:organizationId/clients',
  requireSession,
  requireOrganizationPermission('client', 'create'),
  requireQuota('client'),
  createClientController,
);
clientRouter.get(
  '/workspaces/:organizationId/clients/:clientId/domains',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  listDomainsController,
);
clientRouter.post(
  '/workspaces/:organizationId/clients/:clientId/domains',
  requireSession,
  requireOrganizationPermission('domain', 'create'),
  requireQuota('activeDomain'),
  createDomainController,
);
clientRouter.post(
  '/workspaces/:organizationId/clients/:clientId/domains/bulk',
  requireSession,
  requireOrganizationPermission('domain', 'create'),
  // The per-call cap is enforced inside the service, not by `requireQuota`: that
  // guard measures one domain against the plan allowance and would then let four
  // hundred through, which is a worse answer than a clear refusal. The larger
  // body reader for this path is registered in app.ts, ahead of the global
  // parser, because a body-parser that has already read a body skips it.
  bulkCreateDomainsController,
);
clientRouter.post(
  '/workspaces/:organizationId/domains/:domainId/verify',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  verifyDomainController,
);
