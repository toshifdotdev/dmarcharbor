import { Router } from 'express';
import { createApiKeyController, deleteAllRevokedApiKeysController, deleteApiKeyController, listApiKeysController, revokeApiKeyController } from '../controllers/api-v1.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const apiKeyRouter = Router();

apiKeyRouter.get(
  '/workspaces/:organizationId/api-keys',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
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
  requireOrganizationPermission('billing', 'update'),
  revokeApiKeyController,
);
