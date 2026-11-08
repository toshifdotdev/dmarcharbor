import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import { resourceIdSchema } from '../models/client.model.js';
import { assertFeature, EntitlementError } from '../services/entitlements/entitlement.service.js';
import { zodMessage } from '../utils/zod-messages.js';
import {
  createEndpoint,
  defaultWebhookEvents,
  deleteEndpoint,
  emitEvent,
  listDeliveries,
  listEndpoints,
  replayDelivery,
  rotateEndpointSecret,
  rotationOverlapHours,
  updateEndpoint,
  validateEndpointUrl,
  webhookEvents,
} from '../services/webhook.service.js';

const eventSchema = z.enum(webhookEvents);

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.string().trim().min(1).max(500),
  events: z.array(eventSchema).min(1).max(webhookEvents.length).optional(),
  clientIds: z.array(resourceIdSchema).max(500).optional(),
});

/** Empty means every client. */
const clientIdsSchema = z.array(resourceIdSchema).max(500);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  url: z.string().trim().min(1).max(500).optional(),
  events: z.array(eventSchema).min(1).max(webhookEvents.length).optional(),
  clientIds: clientIdsSchema.optional(),
  active: z.boolean().optional(),
});

const rotateSchema = z.object({
  overlapHours: z.union(rotationOverlapHours.map((hours) => z.literal(hours)) as [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<24>, z.ZodLiteral<168>]),
});

/**
 * The chosen clients, de-duplicated, or an error naming the problem. Every id
 * must be a client of this workspace: an endpoint must never be pointed at
 * another workspace's client, even by a guessed id.
 */
async function checkedClientIds(organizationId: string, ids: string[] | undefined): Promise<string[] | undefined | { error: string }> {
  if (ids === undefined) return undefined;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = await prisma.client.count({ where: { id: { in: unique }, organizationId } });
  return found === unique.length ? unique : { error: 'One or more of the chosen clients is not in this workspace.' };
}

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
      error: { code: 'INVALID_REQUEST', message: zodMessage(body.error.issues) ?? 'A name, a public https url and at least one event are required.' },
    });
    return;
  }

  const checked = validateEndpointUrl(body.data.url);
  if ('error' in checked) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: checked.error } });
    return;
  }

  const clientIds = await checkedClientIds(response.locals.organizationId, body.data.clientIds);
  if (clientIds && 'error' in clientIds) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: clientIds.error } });
    return;
  }

  const { endpoint, secret } = await createEndpoint({
    organizationId: response.locals.organizationId,
    name: body.data.name,
    url: checked.url,
    events: body.data.events ?? defaultWebhookEvents,
    clientIds: clientIds ?? [],
    createdById: response.locals.session?.user?.id,
  });

  response.status(201).json({
    ...endpoint,
    secret,
    notice: 'Copy the secret now. It is stored encrypted and is never shown again.',
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
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: zodMessage(body.error.issues) ?? 'That update is not valid.' } });
    return;
  }

  /**
   * Deactivation is always allowed, so a downgraded workspace can still stop
   * delivery. Everything else — re-enabling, changing events, URL or name — is
   * the feature itself and needs the plan. Checked here rather than as route
   * middleware because only the body distinguishes the two cases.
   */
  const onlyDeactivation = body.data.active === false && Object.keys(request.body ?? {}).length === 1;
  if (!onlyDeactivation) {
    try {
      await assertFeature(response.locals.organizationId, 'integrations.webhooks');
    } catch (error) {
      if (error instanceof EntitlementError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
        return;
      }
      throw error;
    }
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

  const clientIds = await checkedClientIds(response.locals.organizationId, body.data.clientIds);
  if (clientIds && 'error' in clientIds) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: clientIds.error } });
    return;
  }

  const endpoint = await updateEndpoint(
    response.locals.organizationId,
    id.data,
    {
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(body.data.events !== undefined ? { events: body.data.events } : {}),
      ...(clientIds !== undefined ? { clientIds } : {}),
      ...(body.data.active !== undefined ? { active: body.data.active } : {}),
    },
    response.locals.session?.user?.id,
  );

  if (!endpoint) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found in this workspace.' } });
    return;
  }

  response.json(endpoint);
}

export async function rotateWebhookSecretController(request: Request, response: Response): Promise<void> {
  const id = resourceIdSchema.safeParse(request.params.webhookId);
  if (!id.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid webhook identifier is required.' } });
    return;
  }
  const body = rotateSchema.safeParse(request.body ?? {});
  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Choose how long the old secret keeps signing: 0, 1, 24 or 168 hours.' },
    });
    return;
  }

  const rotated = await rotateEndpointSecret({
    organizationId: response.locals.organizationId,
    endpointId: id.data,
    overlapHours: body.data.overlapHours,
    actorUserId: response.locals.session?.user?.id,
  });
  if (!rotated) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found in this workspace.' } });
    return;
  }

  response.json({
    ...rotated.endpoint,
    secret: rotated.secret,
    notice:
      body.data.overlapHours > 0
        ? `Copy the new secret now; it is shown once. Until the overlap ends, every delivery carries two signatures, one per secret, so your receiver keeps working while you switch it.`
        : 'Copy the new secret now; it is shown once. The old secret stopped signing immediately.',
  });
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
  if (replayed === 'not_found') {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Delivery not found in this workspace.' } });
    return;
  }

  if (replayed === 'endpoint_paused') {
    response.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'That endpoint is paused, so nothing is sent to it. Resume the endpoint, then send this again.',
      },
    });
    return;
  }

  response.status(202).json({ queued: true });
}
