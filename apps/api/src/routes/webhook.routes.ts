import { Router } from 'express';
import {
  createWebhookController,
  deleteWebhookController,
  listWebhookDeliveriesController,
  listWebhooksController,
  replayWebhookDeliveryController,
  testWebhookController,
  updateWebhookController,
} from '../controllers/webhook.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

export const webhookRouter = Router();

webhookRouter.get(
  '/workspaces/:organizationId/webhooks',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  listWebhooksController,
);
webhookRouter.post(
  '/workspaces/:organizationId/webhooks',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  createWebhookController,
);
webhookRouter.patch(
  '/workspaces/:organizationId/webhooks/:webhookId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  updateWebhookController,
);
webhookRouter.delete(
  '/workspaces/:organizationId/webhooks/:webhookId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  deleteWebhookController,
);
webhookRouter.post(
  '/workspaces/:organizationId/webhooks/test',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  testWebhookController,
);
webhookRouter.get(
  '/workspaces/:organizationId/webhook-deliveries',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  listWebhookDeliveriesController,
);
webhookRouter.post(
  '/workspaces/:organizationId/webhook-deliveries/:deliveryId/replay',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  replayWebhookDeliveryController,
);
