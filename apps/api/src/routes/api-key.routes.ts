import { Router } from 'express';
import { createApiKeyController, listApiKeysController, revokeApiKeyController } from '../controllers/api-v1.controller.js';
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
apiKeyRouter.delete(
  '/workspaces/:organizationId/api-keys/:keyId',
  requireSession,
  requireOrganizationPermission('billing', 'update'),
  revokeApiKeyController,
);
