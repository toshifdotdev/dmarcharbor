import { createHmac, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from './audit.service.js';
import { decryptSensitive, encryptSensitive } from './privacy.service.js';

export const webhookEvents = [
  'domain.verified',
  'alert.triggered',
  'report.received',
  'entitlement.exceeded',
] as const;

export type WebhookEvent = (typeof webhookEvents)[number];

/**
 * Events most integrations want, and the ones that would otherwise flood a
 * customer who has no use for them. Report notifications are opt in because a
 * large agency receives hundreds a day and ignoring them trains people to
 * ignore the endpoint entirely.
 */
export const defaultWebhookEvents: WebhookEvent[] = ['domain.verified', 'alert.triggered'];

export const signatureHeader = 'x-dmarcharbor-signature';
export const eventHeader = 'x-dmarcharbor-event';
export const deliveryHeader = 'x-dmarcharbor-delivery';
export const deliveryAttemptHeader = 'x-dmarcharbor-attempt';

export const deliveryBatchSize = 50;
export const deliveryTimeoutMs = 10_000;
export const maxAttempts = 5;
export const failureThreshold = 20;
export const suspensionWindowHours = 24;

/** Exponential backoff, capped so a long outage still retries within a day. */
export const retryDelaysMinutes = [1, 5, 30, 120, 720];

export interface RegisteredEndpoint {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  suspendedAt: string | null;
  failureCount: number;
  lastDeliveryAt: string | null;
  createdAt: string;
}

function isLoopbackOrPrivate(hostname: string): boolean {
  // URL parsing keeps IPv6 literals bracketed, so [::1] arrives as "[::1]".
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }
  if (host === '::1' || host === '0.0.0.0' || host === '::') {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0) {
      return true;
    }
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return true;
  }
  return false;
}

export function validateEndpointUrl(raw: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'That is not a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { error: 'The endpoint must use https, because the payload carries a signing secret derived event.' };
  }

  if (isLoopbackOrPrivate(parsed.hostname)) {
    return { error: 'The endpoint must be a public address, not a local or private one.' };
  }

  return { url: parsed.toString() };
}

export function signPayload(secret: string, body: string, timestamp: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export async function createEndpoint(input: {
  organizationId: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  createdById?: string | null;
}): Promise<{ endpoint: RegisteredEndpoint; secret: string }> {
  const secret = randomBytes(32).toString('base64url');

  const row = await prisma.webhookEndpoint.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      url: input.url,
      secret: encryptSensitive(secret),
      events: input.events,
      createdById: input.createdById ?? null,
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.createdById ?? undefined,
    action: 'WEBHOOK_ENDPOINT_CREATED',
    targetType: 'webhook_endpoint',
    targetId: row.id,
    detail: { name: row.name, url: row.url, events: input.events },
  });

  return { endpoint: toRegistered(row), secret };
}

export async function listEndpoints(organizationId: string): Promise<RegisteredEndpoint[]> {
  const rows = await prisma.webhookEndpoint.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toRegistered);
}

export async function updateEndpoint(
  organizationId: string,
  endpointId: string,
  data: { name?: string; url?: string; events?: WebhookEvent[]; active?: boolean },
): Promise<RegisteredEndpoint | null> {
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, organizationId } });
  if (!existing) {
    return null;
  }

  const row = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.events !== undefined ? { events: data.events } : {}),
      ...(data.active !== undefined ? { active: data.active, suspendedAt: data.active ? null : new Date() } : {}),
    },
  });

  await recordAuditEvent({
    organizationId,
    action: 'WEBHOOK_ENDPOINT_UPDATED',
    targetType: 'webhook_endpoint',
    targetId: endpointId,
    detail: { ...data },
  });

  return toRegistered(row);
}

export async function deleteEndpoint(organizationId: string, endpointId: string): Promise<boolean> {
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, organizationId } });
  if (!existing) {
    return false;
  }

  await prisma.webhookEndpoint.delete({ where: { id: endpointId } });

  await recordAuditEvent({
    organizationId,
    action: 'WEBHOOK_ENDPOINT_DELETED',
    targetType: 'webhook_endpoint',
    targetId: endpointId,
    detail: { name: existing.name },
  });

  return true;
}

function toRegistered(row: {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  suspendedAt: Date | null;
  failureCount: number;
  lastDeliveryAt: Date | null;
  createdAt: Date;
}): RegisteredEndpoint {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events as WebhookEvent[],
    active: row.active && row.suspendedAt === null,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    failureCount: row.failureCount,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Records that an event happened. The payload is a pointer, not the data itself.
 *
 * A large agency receives hundreds of report notifications a day. Embedding the
 * report would make every delivery large, slow and likely to fail, and would
 * duplicate what the read API already serves. The event says what happened and
 * which identifier to fetch, and the integration asks for detail only if it
 * wants it.
 */
export async function emitEvent(
  organizationId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  now = new Date(),
): Promise<number> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { organizationId, active: true, suspendedAt: null },
    select: { id: true, events: true },
  });

  const subscribed = endpoints.filter((endpoint) => (endpoint.events as string[]).includes(event));
  if (subscribed.length === 0) {
    return 0;
  }

  const body = {
    id: `evt_${randomBytes(9).toString('base64url')}`,
    type: event,
    createdAt: now.toISOString(),
    data,
  };

  await prisma.webhookDelivery.createMany({
    data: subscribed.map((endpoint) => ({
      endpointId: endpoint.id,
      organizationId,
      event,
      payload: body as unknown as Prisma.InputJsonValue,
      status: 'PENDING' as const,
      nextAttemptAt: now,
    })),
  });

  return subscribed.length;
}

export interface DeliveryOutcome {
  deliveryId: string;
  status: 'DELIVERED' | 'RETRY' | 'FAILED';
  responseCode?: number;
  error?: string;
}

export async function deliverDueWebhooks(now = new Date()): Promise<DeliveryOutcome[]> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    select: {
      id: true,
      endpointId: true,
      event: true,
      payload: true,
      attempts: true,
      endpoint: { select: { id: true, url: true, secret: true, failureCount: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: deliveryBatchSize,
  });

  const outcomes: DeliveryOutcome[] = [];

  for (const delivery of due) {
    const attempt = delivery.attempts + 1;
    const body = JSON.stringify(delivery.payload);
    const secret = decryptSensitive(delivery.endpoint.secret) ?? '';
    const timestamp = Math.floor(now.getTime() / 1000);

    let responseCode: number | undefined;
    let error: string | undefined;

    try {
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [signatureHeader]: signPayload(secret, body, timestamp),
          [eventHeader]: delivery.event,
          [deliveryHeader]: delivery.id,
          [deliveryAttemptHeader]: String(attempt),
          'user-agent': 'DMARC-Harbor-Webhook/1',
        },
        body,
        signal: AbortSignal.timeout(deliveryTimeoutMs),
      });
      responseCode = response.status;
      if (response.status >= 200 && response.status < 300) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'DELIVERED', attempts: attempt, responseCode, deliveredAt: now, lastError: null },
        });
        await prisma.webhookEndpoint.update({
          where: { id: delivery.endpoint.id },
          data: { lastDeliveryAt: now, failureCount: 0, suspendedAt: null },
        });
        outcomes.push({ deliveryId: delivery.id, status: 'DELIVERED', responseCode });
        continue;
      }
      error = `Endpoint responded ${response.status}.`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The endpoint could not be reached.';
    }

    const exhausted = attempt >= maxAttempts;
    const nextDelay = retryDelaysMinutes[Math.min(attempt - 1, retryDelaysMinutes.length - 1)] ?? 720;
    const nextAttemptAt = new Date(now.getTime() + nextDelay * 60 * 1000);

    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attempt,
        responseCode,
        lastError: error,
        status: exhausted ? 'FAILED' : 'PENDING',
        nextAttemptAt: exhausted ? null : nextAttemptAt,
      },
    });

    const failureCount = delivery.endpoint.failureCount + 1;
    const shouldSuspend = failureCount >= failureThreshold;

    await prisma.webhookEndpoint.update({
      where: { id: delivery.endpoint.id },
      data: {
        failureCount,
        ...(shouldSuspend
          ? { suspendedAt: new Date(now.getTime() + suspensionWindowHours * 60 * 60 * 1000) }
          : {}),
      },
    });

    if (shouldSuspend) {
      await prisma.webhookDelivery.updateMany({
        where: { endpointId: delivery.endpoint.id, status: 'PENDING' },
        data: { status: 'SUSPENDED' },
      });
      await recordAuditEvent({
        organizationId: (await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: delivery.endpoint.id } })).organizationId,
        action: 'WEBHOOK_ENDPOINT_SUSPENDED',
        targetType: 'webhook_endpoint',
        targetId: delivery.endpoint.id,
        detail: { failures: failureCount, suspendedForHours: suspensionWindowHours },
      });
    }

    outcomes.push({ deliveryId: delivery.id, status: exhausted ? 'FAILED' : 'RETRY', responseCode, error });
  }

  return outcomes;
}

export async function listDeliveries(organizationId: string, endpointId?: string, limit = 50) {
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { organizationId, ...(endpointId ? { endpointId } : {}) },
    select: {
      id: true,
      endpointId: true,
      event: true,
      status: true,
      attempts: true,
      responseCode: true,
      lastError: true,
      deliveredAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return deliveries;
}

export async function replayDelivery(organizationId: string, deliveryId: string): Promise<boolean> {
  const delivery = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId, organizationId } });
  if (!delivery) {
    return false;
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, responseCode: null },
  });

  return true;
}
