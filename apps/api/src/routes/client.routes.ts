import { Router } from 'express';
import {
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
  '/workspaces/:organizationId/domains/:domainId/verify',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  verifyDomainController,
);
