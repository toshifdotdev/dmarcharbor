import type { Request, Response } from 'express';
import { z } from 'zod';
import { resourceIdSchema } from '../models/client.model.js';
import {
  createEndpoint,
  defaultWebhookEvents,
  deleteEndpoint,
  emitEvent,
  listDeliveries,
  listEndpoints,
  replayDelivery,
  updateEndpoint,
  validateEndpointUrl,
  webhookEvents,
} from '../services/webhook.service.js';

const eventSchema = z.enum(webhookEvents);

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.string().trim().min(1).max(500),
  events: z.array(eventSchema).min(1).max(4).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  url: z.string().trim().min(1).max(500).optional(),
  events: z.array(eventSchema).min(1).max(4).optional(),
  active: z.boolean().optional(),
});

export async function listWebhooksController(_request: Request, response: Response): Promise<void> {
  response.json({
    endpoints: await listEndpoints(response.locals.organizationId),
    events: webhookEvents,
    defaultEvents: defaultWebhookEvents,
  });
}

export async function createWebhookController(request: Request, response: Response): Promise<void> {
  const body = createSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: body.error.issues[0]?.message ?? 'A name, a public https url and at least one event are required.' },
    });
    return;
  }

  const checked = validateEndpointUrl(body.data.url);
  if ('error' in checked) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: checked.error } });
    return;
  }

  const { endpoint, secret } = await createEndpoint({
    organizationId: response.locals.organizationId,
    name: body.data.name,
    url: checked.url,
    events: body.data.events ?? defaultWebhookEvents,
    createdById: response.locals.session?.user?.id,
  });

  response.status(201).json({
    ...endpoint,
    secret,
    notice: 'Copy the secret now. It is stored encrypted and is never shown again. Use it to verify our signatures.',
  });
}

export async function updateWebhookController(request: Request, response: Response): Promise<void> {
  const id = resourceIdSchema.safeParse(request.params.webhookId);
  if (!id.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid webhook identifier is required.' } });
    return;
  }

  const body = updateSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: body.error.issues[0]?.message ?? 'That update is not valid.' } });
    return;
  }

  let url: string | undefined;
  if (body.data.url) {
    const checked = validateEndpointUrl(body.data.url);
    if ('error' in checked) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST', message: checked.error } });
      return;
    }
    url = checked.url;
  }

  const endpoint = await updateEndpoint(response.locals.organizationId, id.data, {
    ...(body.data.name !== undefined ? { name: body.data.name } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(body.data.events !== undefined ? { events: body.data.events } : {}),
    ...(body.data.active !== undefined ? { active: body.data.active } : {}),
  });

  if (!endpoint) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found in this workspace.' } });
    return;
  }

  response.json(endpoint);
}

export async function deleteWebhookController(request: Request, response: Response): Promise<void> {
  const id = resourceIdSchema.safeParse(request.params.webhookId);
  if (!id.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid webhook identifier is required.' } });
    return;
  }

  const removed = await deleteEndpoint(response.locals.organizationId, id.data);
  if (!removed) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found in this workspace.' } });
    return;
  }

  response.status(204).send();
}

export async function testWebhookController(request: Request, response: Response): Promise<void> {
  const emitted = await emitEvent(response.locals.organizationId, 'domain.verified', {
    test: true,
    domainId: 'test',
    domainName: 'example.com',
    message: 'This is a test delivery from DMARC Harbor. No action is required.',
  });

  response.status(202).json({
    queued: emitted,
    notice:
      emitted === 0
        ? 'No endpoint is subscribed to this event yet, so nothing was queued. Subscribe an endpoint first.'
        : 'Queued. Check the delivery log for the result.',
  });
}

export async function listWebhookDeliveriesController(request: Request, response: Response): Promise<void> {
  const endpointId = typeof request.query.endpointId === 'string' ? request.query.endpointId : undefined;
  response.json({ deliveries: await listDeliveries(response.locals.organizationId, endpointId) });
}

export async function replayWebhookDeliveryController(request: Request, response: Response): Promise<void> {
  const id = resourceIdSchema.safeParse(request.params.deliveryId);
  if (!id.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid delivery identifier is required.' } });
    return;
  }

  const replayed = await replayDelivery(response.locals.organizationId, id.data);
  if (!replayed) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Delivery not found in this workspace.' } });
    return;
  }

  response.status(202).json({ queued: true });
}
