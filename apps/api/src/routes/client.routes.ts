import { Router } from 'express';
import {
  bulkCreateDomainsController,
  clientReportAddressController,
  createClientController,
  createDomainController,
  listClientsController,
  listDomainsController,
  verifyDomainController,
} from '../controllers/client.controller.js';
import {
  clientBookExportController,
  domainMovePreviewController,
  moveDomainController,
  renameClientController,
} from '../controllers/operations.controller.js';
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
/**
 * The client book as CSV. Declared before any `/clients/:clientId` read so the
 * word "export" can never be taken for a client id, even if a single-client
 * read is added later.
 */
clientRouter.get(
  '/workspaces/:organizationId/clients/export',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  clientBookExportController,
);
clientRouter.post(
  '/workspaces/:organizationId/clients',
  requireSession,
  requireOrganizationPermission('client', 'create'),
  requireQuota('client'),
  createClientController,
);
clientRouter.post(
  '/workspaces/:organizationId/clients/:clientId/rename',
  requireSession,
  // `client: update` is declared in permissions.ts and held by owner and admin,
  // the same people who may create and delete a client.
  requireOrganizationPermission('client', 'update'),
  renameClientController,
);
clientRouter.get(
  '/workspaces/:organizationId/clients/:clientId/report-address',
  requireSession,
  requireOrganizationPermission('client', 'read'),
  clientReportAddressController,
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
/**
 * Moving a domain between clients changes what two clients hold and which
 * portal contacts can see it, so it takes `client: update` (owner and admin)
 * rather than `domain: update`, which an analyst also holds. The preview takes
 * the same right: it names digest recipients and counts both clients' portal
 * contacts.
 */
clientRouter.get(
  '/workspaces/:organizationId/domains/:domainId/move-preview',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  domainMovePreviewController,
);
clientRouter.post(
  '/workspaces/:organizationId/domains/:domainId/move',
  requireSession,
  requireOrganizationPermission('client', 'update'),
  moveDomainController,
);
