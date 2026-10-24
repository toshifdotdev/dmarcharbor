import { Router } from 'express';
import { createApiKeyController, deleteAllRevokedApiKeysController, deleteApiKeyController, listApiKeysController, revokeApiKeyController } from '../controllers/api-v1.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const apiKeyRouter = Router();

/**
 * Who may do what. Reading the list and revoking are owner OR admin: the list
 * holds only prefixes and names, and revoking a leaked key is the urgent, safe
 * direction, which should not wait for the one owner. Issuing a key (which acts
 * for the whole workspace) and erasing a revoked key's record stay owner only.
 */
apiKeyRouter.get(
  '/workspaces/:organizationId/api-keys',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  listApiKeysController,
);
apiKeyRouter.post(
  '/workspaces/:organizationId/api-keys',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  createApiKeyController,
);
/**
 * Residue cleanup, declared BEFORE `/:keyId` so "revoked" is never read as a key
 * id. Express matches in registration order.
 */
apiKeyRouter.delete(
  '/workspaces/:organizationId/api-keys/revoked',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  deleteAllRevokedApiKeysController,
);
apiKeyRouter.delete(
  '/workspaces/:organizationId/api-keys/:keyId/permanent',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  deleteApiKeyController,
);
apiKeyRouter.delete(
  '/workspaces/:organizationId/api-keys/:keyId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  revokeApiKeyController,
);
