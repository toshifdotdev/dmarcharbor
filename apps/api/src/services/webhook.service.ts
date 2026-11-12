import { randomUUID } from 'node:crypto';
import { createHmac, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from './audit.service.js';
import { decryptSensitive, encryptSensitive } from './privacy.service.js';
import { isPrivateOrReservedHost } from './net-guard.js';
import { guardedRequest, type GuardedRequester } from './net/guarded-request.js';
import { retryAfterSeconds } from './psa/provider.js';

let requesterOverride: GuardedRequester | null = null;

/**
 * Replaces the pinned requester, for tests only: a unit test can then prove a
 * rebinding name is refused without a network. Integration suites use the real
 * one against a loopback receiver.
 */
export function setWebhookRequesterForTests(requester: GuardedRequester | null): void {
  requesterOverride = requester;
}

function webhookRequest(...args: Parameters<GuardedRequester>): ReturnType<GuardedRequester> {
  return (requesterOverride ?? guardedRequest)(...args);
}

export const webhookEvents = [
  'domain.verified',
  'alert.triggered',
  'report.received',
  'entitlement.exceeded',
  'dns.changed',
  'policy.changed',
  'forensic.received',
  'tlsrpt.received',
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
/**
 * The exact timestamp the signature was computed over.
 *
 * Sent as its own header so a receiver never has to use its own clock, or
 * guess when the request was made. Anything else makes verification depend on
 * the two machines agreeing to the second, which fails intermittently and is
 * indistinguishable from a forgery.
 */
export const timestampHeader = 'x-dmarcharbor-timestamp';

export const deliveryBatchSize = 50;
export const deliveryTimeoutMs = 10_000;
export const maxAttempts = 5;
export const failureThreshold = 20;
export const suspensionWindowHours = 24;

/**
 * The wait after each failed attempt. With five attempts only the first four
 * are used (1, 5, 30 and 120 minutes); the fifth failure gives up, and the day
 * old requeue in `repairWebhookEndpoints` is what covers a longer outage.
 */
export const retryDelaysMinutes = [1, 5, 30, 120, 720];

/**
 * How long a dead endpoint is left suspended before it is probed again.
 *
 * Long enough that a customer with a genuinely broken integration is not
 * hammered, and short enough that somebody who fixes their server overnight is
 * not left permanently disconnected. Without this an endpoint suspended once
 * never came back on its own, and only a human looking at a dashboard would
 * notice, which is the opposite of self healing.
 */
export const suspensionProbeHours = 6;

/**
 * How long a given delivery is left dead before it is requeued.
 *
 * The five in-cycle retries cover a blip. This covers the case where the whole
 * window fell inside an outage: the events that failed during it would otherwise
 * be lost, and a monitoring product that drops its customer's events during the
 * customer's own outage is the worst possible time to do it.
 *
 * Requeueing is bounded by the endpoint's failure count, which is not reset
 * here, so a permanently dead endpoint still reaches the suspension threshold
 * and stops.
 */
export const deadDeliveryRequeueHours = 24;

export interface WebhookRepairOutcome {
  endpointsProbed: number;
  endpointsRecovered: number;
  deliveriesRequeued: number;
  endpointsStillFailing: number;
}

/**
 * Repairs two ways a webhook integration dies permanently.
 *
 * The first is an endpoint suspended after too many failures. It stays suspended
 * for ever, so a customer whose server was down overnight never receives
 * anything again and never finds out, because nothing tells them. This resets
 * the counter after the probe window, which turns a permanent disconnection into
 * one trial delivery: if the server is still broken the endpoint climbs back to
 * suspended, and if it is fixed the customer is reconnected without a human
 * involved.
 *
 * The second is a delivery that used up its retries. It is marked failed and
 * never looked at again, so the events that failed inside the customer's outage
 * are simply gone. Requeuing them means a monitoring product stops losing data
 * exactly when its customer is already in trouble.
 *
 * Both are half open transitions: one attempt decides, and the failure counter
 * is not reset for the delivery path, so a dead endpoint converges on suspended
 * rather than retrying for ever.
 */
export async function repairWebhookEndpoints(now = new Date()): Promise<WebhookRepairOutcome> {
  const outcome: WebhookRepairOutcome = {
    endpointsProbed: 0,
    endpointsRecovered: 0,
    deliveriesRequeued: 0,
    endpointsStillFailing: 0,
  };

  // 1. Probe endpoints whose suspension window has passed.
  //
  // Active ones only. Pausing writes `suspendedAt` too, so without this a paused
  // endpoint looked like an expired suspension six hours later: it was "probed",
  // audited as such, and its held deliveries released, which undid the pause.
  const probeBefore = new Date(now.getTime() - suspensionProbeHours * 60 * 60 * 1000);
  const due = await prisma.webhookEndpoint.findMany({
    where: { active: true, suspendedAt: { lte: probeBefore } },
    select: { id: true, organizationId: true, failureCount: true },
    take: 100,
  });

  for (const endpoint of due) {
    // A trial delivery is the test. Only the endpoints that have something to
    // retry are worth probing, and an endpoint with nothing queued is left
    // suspended so it does not sit in a half open state with no way to close.
    const queued = await prisma.webhookDelivery.count({
      where: { endpointId: endpoint.id, status: { in: ['PENDING', 'SUSPENDED'] } },
    });

    if (queued === 0) {
      outcome.endpointsStillFailing += 1;
      continue;
    }

    const reopened = await prisma.webhookEndpoint.updateMany({
      where: { id: endpoint.id, active: true, suspendedAt: { lte: probeBefore } },
      data: { suspendedAt: null, failureCount: Math.floor(endpoint.failureCount / 2) },
    });

    if (reopened.count !== 1) {
      continue;
    }

    outcome.endpointsProbed += 1;

    await prisma.webhookDelivery.updateMany({
      where: { endpointId: endpoint.id, status: 'SUSPENDED' },
      data: { status: 'PENDING', claimedAt: null, claimedBy: null, nextAttemptAt: now },
    });

    await recordAuditEvent({
      organizationId: endpoint.organizationId,
      action: 'WEBHOOK_ENDPOINT_PROBED',
      targetType: 'webhook_endpoint',
      targetId: endpoint.id,
      detail: {
        note: 'Suspension window elapsed, so a trial delivery was queued. One attempt decides whether the endpoint recovers.',
        previousFailureCount: endpoint.failureCount,
      },
    });
  }

  // 2. Requeue deliveries that died inside a customer outage. Not for a paused
  // endpoint: the requeue would wait for the resume and then send a day's old
  // failures at once, which is not what pausing asked for.
  const deadBefore = new Date(now.getTime() - deadDeliveryRequeueHours * 60 * 60 * 1000);
  const requeued = await prisma.webhookDelivery.updateMany({
    where: {
      status: 'FAILED',
      deliveredAt: null,
      createdAt: { lte: deadBefore },
      endpoint: { active: true, suspendedAt: null },
    },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, claimedAt: null, claimedBy: null },
  });

  outcome.deliveriesRequeued = requeued.count;

  if (requeued.count > 0) {
    console.info(
      `[webhooks] requeued ${requeued.count} delivery(ies) that failed more than ${deadDeliveryRequeueHours} hours ago, so events lost in a customer outage are retried rather than dropped`,
    );
  }

  return outcome;
}

export interface RegisteredEndpoint {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  /** Clients whose events it receives; empty means every client. */
  clientIds: string[];
  /** Until when deliveries are also signed with the secret before the last rotation. */
  previousSecretExpiresAt: string | null;
  /** False when paused or suspended: nothing is sent to it. */
  active: boolean;
  /** Set when paused or suspended. */
  suspendedAt: string | null;
  /** True when it stopped itself after repeated failures, as opposed to being paused. */
  suspended: boolean;
  /** When a suspended endpoint gets its one trial delivery, if nobody resumes it first. */
  probeAt: string | null;
  failureCount: number;
  lastDeliveryAt: string | null;
  createdAt: string;
}

/** The overlaps offered when rotating: none, an hour, a day, a week. */
export const rotationOverlapHours = [0, 1, 24, 168] as const;

/**
 * The signature header's value: one `sha256=` per secret in use, the current
 * secret first, separated by ", ". After a rotation the previous secret signs
 * too until its overlap ends, so a receiver that accepts any listed value can
 * switch secrets with no delivery refused.
 */
export function signatureValue(secrets: string[], body: string, timestamp: number): string {
  return secrets.map((secret) => signPayload(secret, body, timestamp)).join(', ');
}

export function validateEndpointUrl(raw: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'That is not a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { error: 'The endpoint must use https: every delivery is signed, and over plain http anyone on the way can read or change it.' };
  }

  if (isPrivateOrReservedHost(parsed.hostname)) {
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
  clientIds?: string[];
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
      clientIds: input.clientIds ?? [],
      createdById: input.createdById ?? null,
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.createdById ?? undefined,
    action: 'WEBHOOK_ENDPOINT_CREATED',
    targetType: 'webhook_endpoint',
    targetId: row.id,
    detail: { name: row.name, url: row.url, events: input.events, clientIds: input.clientIds ?? [] },
  });

  return { endpoint: toRegistered(row), secret };
}

/**
 * Replaces an endpoint's signing secret and returns the new one, once.
 *
 * With an overlap, the old secret keeps signing alongside the new one until
 * the overlap ends, so the receiver can be switched at its own pace. With no
 * overlap the old secret stops at once, for a secret that has leaked. A second
 * rotation inside an overlap drops the oldest secret: two are signed with at
 * most.
 */
export async function rotateEndpointSecret(input: {
  organizationId: string;
  endpointId: string;
  overlapHours: (typeof rotationOverlapHours)[number];
  actorUserId?: string | null;
  now?: Date;
}): Promise<{ endpoint: RegisteredEndpoint; secret: string } | null> {
  const now = input.now ?? new Date();
  const existing = await prisma.webhookEndpoint.findFirst({
    where: { id: input.endpointId, organizationId: input.organizationId },
    select: { id: true, secret: true },
  });
  if (!existing) return null;

  const secret = randomBytes(32).toString('base64url');
  const row = await prisma.webhookEndpoint.update({
    where: { id: existing.id },
    data: {
      secret: encryptSensitive(secret),
      previousSecret: input.overlapHours > 0 ? existing.secret : null,
      previousSecretExpiresAt: input.overlapHours > 0 ? new Date(now.getTime() + input.overlapHours * 3_600_000) : null,
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'WEBHOOK_SECRET_ROTATED',
    targetType: 'webhook_endpoint',
    targetId: row.id,
    detail: { name: row.name, overlapHours: input.overlapHours },
  });

  return { endpoint: toRegistered(row, now), secret };
}

export async function listEndpoints(organizationId: string): Promise<RegisteredEndpoint[]> {
  const rows = await prisma.webhookEndpoint.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => toRegistered(row));
}

export async function updateEndpoint(
  organizationId: string,
  endpointId: string,
  data: { name?: string; url?: string; events?: WebhookEvent[]; clientIds?: string[]; active?: boolean },
  actorUserId?: string | null,
): Promise<RegisteredEndpoint | null> {
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, organizationId } });
  if (!existing) {
    return null;
  }

  /**
   * Resuming a suspended endpoint ends the suspension outright: the failure
   * count starts again from nothing and the deliveries it held are sent on the
   * next pass, as a paused endpoint's are. Leaving the count at the threshold
   * meant one more failure suspended it again at once, and the held deliveries
   * stayed held while the screen said the endpoint was receiving.
   */
  const endsSuspension =
    data.active === true &&
    existing.suspendedAt !== null &&
    (existing.active || existing.failureCount >= failureThreshold);
  if (endsSuspension) {
    await prisma.webhookDelivery.updateMany({
      where: { endpointId, status: 'SUSPENDED' },
      data: { status: 'PENDING', nextAttemptAt: new Date(), claimedAt: null, claimedBy: null },
    });
  }

  const row = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: {
      ...(endsSuspension ? { failureCount: 0 } : {}),
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.events !== undefined ? { events: data.events } : {}),
      ...(data.clientIds !== undefined ? { clientIds: data.clientIds } : {}),
      // Pausing leaves the queue as it is: the worker skips an inactive
      // endpoint's deliveries, so resuming sends them without another step.
      ...(data.active !== undefined ? { active: data.active, suspendedAt: data.active ? null : new Date() } : {}),
    },
  });

  await recordAuditEvent({
    organizationId,
    actorUserId: actorUserId ?? undefined,
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

function toRegistered(
  row: {
    id: string;
    name: string;
    url: string;
    events: string[];
    clientIds: string[];
    previousSecretExpiresAt: Date | null;
    active: boolean;
    suspendedAt: Date | null;
    failureCount: number;
    lastDeliveryAt: Date | null;
    createdAt: Date;
  },
  now = new Date(),
): RegisteredEndpoint {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events as WebhookEvent[],
    clientIds: row.clientIds ?? [],
    previousSecretExpiresAt:
      row.previousSecretExpiresAt && row.previousSecretExpiresAt > now ? row.previousSecretExpiresAt.toISOString() : null,
    active: row.active && row.suspendedAt === null,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    // Pausing clears `active`; a suspension leaves it and sets `suspendedAt`.
    suspended: row.active && row.suspendedAt !== null,
    probeAt:
      row.active && row.suspendedAt
        ? new Date(row.suspendedAt.getTime() + suspensionProbeHours * 60 * 60 * 1000).toISOString()
        : null,
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
    select: { id: true, events: true, clientIds: true },
  });

  const wanted = endpoints.filter((endpoint) => (endpoint.events as string[]).includes(event));
  const subscribed = await forClient(organizationId, wanted, data);
  if (subscribed.length === 0) {
    return 0;
  }

  /**
   * No outbound integration on a plan that does not include webhooks.
   *
   * The check is after the subscribed lookup and only when something is
   * subscribed: a free workspace with no endpoint pays for no entitlement read.
   * Deliveries already queued before a downgrade are left alone; they were
   * accepted while the feature was licensed and stopping them mid-flight would
   * lose an event the receiver may already be retrying.
   *
   * Dynamic import because entitlement.service imports emitEvent. A static
   * import here would close the cycle at module load.
   */
  const { resolveEntitlements } = await import('./entitlements/entitlement.service.js');
  const entitlements = await resolveEntitlements(organizationId, now);
  if (!entitlements.features['integrations.webhooks']) {
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

/**
 * Drops the endpoints limited to other clients.
 *
 * The client is read at emit time from the event's domain, because a domain
 * can move between clients. An event about no domain (entitlement.exceeded,
 * the test event) is about the workspace, and goes to every endpoint. An event
 * naming a domain that no longer resolves goes only to endpoints for every
 * client: an endpoint limited to one client is often that client's own
 * system, and must never receive another client's domain.
 */
async function forClient<T extends { clientIds: string[] }>(
  organizationId: string,
  endpoints: T[],
  data: Record<string, unknown>,
): Promise<T[]> {
  if (endpoints.every((endpoint) => endpoint.clientIds.length === 0)) return endpoints;
  if (data.test === true) return endpoints;

  let clientId: string | null = typeof data.clientId === 'string' ? data.clientId : null;
  const domainId = typeof data.domainId === 'string' ? data.domainId : null;
  if (!clientId && !domainId) return endpoints;
  if (!clientId && domainId) {
    const domain = await prisma.domain.findFirst({
      where: { id: domainId, client: { organizationId } },
      select: { clientId: true },
    });
    clientId = domain?.clientId ?? null;
  }
  return endpoints.filter(
    (endpoint) => endpoint.clientIds.length === 0 || (clientId !== null && endpoint.clientIds.includes(clientId)),
  );
}

export interface DeliveryOutcome {
  deliveryId: string;
  status: 'DELIVERED' | 'RETRY' | 'FAILED';
  responseCode?: number;
  error?: string;
}

/**
 * How long a claim is honoured before the delivery is considered abandoned.
 *
 * Longer than the request timeout, so a request that is merely slow is never
 * stolen out from under the instance still waiting on it. An instance that dies
 * mid request costs one delivery this much delay rather than a stranded row.
 */
const claimLeaseMs = deliveryTimeoutMs + 60_000;

let instanceId: string | undefined;

/** Identifies this process in the claim, so a stuck row can be traced back. */
function currentInstanceId(): string {
  instanceId ??= `${process.pid}-${randomUUID()}`;
  return instanceId;
}

/**
 * Returns deliveries this instance owns, and only those.
 *
 * The claim is a conditional update keyed on the row still being PENDING, so
 * when two instances read the same due list exactly one of them moves each row.
 * That is what makes a delivery happen once per event under any number of
 * replicas, and it is a transaction scoped single statement, so it is safe with
 * a pooled connection. An advisory lock would not be: it is session scoped, so
 * the lock and the unlock would land on different pooled sessions and the lock
 * would be leaked rather than released.
 *
 * Abandoned claims are reclaimed first. An instance killed mid request leaves
 * its rows in IN_FLIGHT, and without that sweep a customer's events would be
 * silently dropped instead of retried.
 */
type ClaimableDelivery = {
  id: string;
  endpointId: string;
  event: string;
  payload: unknown;
  attempts: number;
  endpoint: {
    id: string;
    url: string;
    secret: string | null;
    previousSecret: string | null;
    previousSecretExpiresAt: Date | null;
    failureCount: number;
  };
};

async function claimDueDeliveries(now: Date): Promise<ClaimableDelivery[]> {
  const staleBefore = new Date(now.getTime() - claimLeaseMs);

  await prisma.webhookDelivery.updateMany({
    where: { status: 'IN_FLIGHT', claimedAt: { lt: staleBefore } },
    data: { status: 'PENDING', claimedAt: null, claimedBy: null },
  });

  /**
   * A paused endpoint's deliveries are held where they are.
   *
   * Pausing stopped new events being queued, and nothing else: the worker
   * claimed every PENDING row whatever its endpoint said, so events queued
   * before the pause (and every retry of them) were still sent to a receiver
   * the operator had just asked us to leave alone. They stay PENDING rather than
   * being moved, so resuming needs no step of its own: the next pass sends them,
   * with their attempts and their retry times as they were.
   *
   * The filter is in the query, not applied after it, so a paused endpoint with
   * a long queue cannot fill the batch and starve every other endpoint. It is
   * repeated on the claim, which closes the gap between reading the list and
   * taking a row when somebody pauses in between. A request already on the wire
   * when the pause lands still finishes.
   */
  const candidates = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now }, endpoint: { active: true } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: deliveryBatchSize,
  });

  const claimed: { id: string }[] = [];

  for (const candidate of candidates) {
    const result = await prisma.webhookDelivery.updateMany({
      where: { id: candidate.id, status: 'PENDING', endpoint: { active: true } },
      data: { status: 'IN_FLIGHT', claimedAt: now, claimedBy: currentInstanceId() },
    });

    if (result.count === 1) {
      claimed.push(candidate);
    }
  }

  if (claimed.length === 0) {
    return [];
  }

  return prisma.webhookDelivery.findMany({
    where: { id: { in: claimed.map((row) => row.id) } },
    select: {
      id: true,
      endpointId: true,
      event: true,
      payload: true,
      attempts: true,
      endpoint: {
        select: { id: true, url: true, secret: true, previousSecret: true, previousSecretExpiresAt: true, failureCount: true },
      },
    },
  });
}

export async function deliverDueWebhooks(now = new Date()): Promise<DeliveryOutcome[]> {
  const due = await claimDueDeliveries(now);

  const outcomes: DeliveryOutcome[] = [];
  /**
   * Endpoints suspended during this pass. The rest of the batch was claimed
   * before the suspension, so without this every later delivery to the same
   * endpoint was still sent, failed, and suspended it again: one audit row and
   * one notice per delivery instead of one per suspension.
   */
  const suspendedThisPass = new Set<string>();

  for (const delivery of due) {
    if (suspendedThisPass.has(delivery.endpoint.id)) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SUSPENDED', claimedAt: null, claimedBy: null },
      });
      continue;
    }
    const attempt = delivery.attempts + 1;
    const body = JSON.stringify(delivery.payload);
    const secret = decryptSensitive(delivery.endpoint.secret) ?? '';
    // Inside a rotation's overlap the previous secret signs as well, after the current one.
    const previous =
      delivery.endpoint.previousSecret &&
      delivery.endpoint.previousSecretExpiresAt &&
      delivery.endpoint.previousSecretExpiresAt > now
        ? decryptSensitive(delivery.endpoint.previousSecret)
        : null;
    const secrets = previous ? [secret, previous] : [secret];
    const timestamp = Math.floor(now.getTime() / 1000);

    let responseCode: number | undefined;
    let error: string | undefined;
    let retryAfter: number | undefined;
    let rateLimited = false;

    try {
      /**
       * Resolved, checked and pinned in one place: `webhookRequest`.
       *
       * The registration check validates the string as written, so a hostname
       * accepted then can resolve to the cloud metadata service by the time a
       * delivery reaches it, and the row need never be re-saved for that to be
       * true. Every delivery therefore resolves the name, refuses any private or
       * reserved answer, and opens the socket to exactly the address it checked.
       *
       * This used global `fetch` with a `lookup` option and a `host` header.
       * Node's fetch (undici) ignores both, so the "pinned" request resolved the
       * name a second time at connect: a DNS-rebinding name could answer a
       * public address for the check and 169.254.169.254 for the connection.
       *
       * Redirects are not followed: a 3xx is recorded as the response code it
       * is, so an accepted endpoint cannot bounce the request somewhere the
       * check never saw. A receiver that redirects should register the final URL.
       */
      const result = await webhookRequest({
        url: delivery.endpoint.url,
        method: 'POST',
        policy: 'webhook',
        headers: {
          [signatureHeader]: signatureValue(secrets, body, timestamp),
          [timestampHeader]: String(timestamp),
          [eventHeader]: delivery.event,
          [deliveryHeader]: delivery.id,
          [deliveryAttemptHeader]: String(attempt),
          'user-agent': 'DMARC-Harbor-Webhook/1',
        },
        // Sent byte for byte: the signature is over exactly this string.
        body: { kind: 'text', value: body, contentType: 'application/json' },
        timeoutMs: deliveryTimeoutMs,
        maxBytes: 65_536,
      });

      if (result.status === 'error') {
        if (result.failure === 'redirect' && result.statusCode !== undefined) {
          responseCode = result.statusCode;
          throw new Error(`Endpoint responded ${result.statusCode}. Redirects are not followed; register the final URL.`);
        }
        throw new Error(result.detail);
      }

      responseCode = result.statusCode;
      if (result.statusCode >= 200 && result.statusCode < 300) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'DELIVERED', attempts: attempt, responseCode, deliveredAt: now, lastError: null, claimedAt: null, claimedBy: null },
        });
        await prisma.webhookEndpoint.update({
          where: { id: delivery.endpoint.id },
          data: { lastDeliveryAt: now, failureCount: 0, suspendedAt: null },
        });
        outcomes.push({ deliveryId: delivery.id, status: 'DELIVERED', responseCode });
        continue;
      }
      error = `Endpoint responded ${result.statusCode}.`;
      // A receiver that says how long to wait is asked again then, as the PSA
      // queue already does (session 8).
      if (result.statusCode === 429 || result.statusCode === 503) {
        retryAfter = retryAfterSeconds(result.headers['retry-after']);
        rateLimited = result.statusCode === 429;
        if (retryAfter !== undefined) {
          error = `Endpoint responded ${result.statusCode} and asked to wait ${retryAfter} seconds.`;
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The endpoint could not be reached.';
    }

    const exhausted = attempt >= maxAttempts;
    const scheduledDelay = retryDelaysMinutes[Math.min(attempt - 1, retryDelaysMinutes.length - 1)] ?? 720;
    // Retry-After wins over the schedule, held between one minute and twelve hours.
    const nextDelay = retryAfter !== undefined ? Math.min(Math.max(retryAfter / 60, 1), 720) : scheduledDelay;
    const nextAttemptAt = new Date(now.getTime() + nextDelay * 60 * 1000);

    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attempt,
        responseCode,
        lastError: error,
        status: exhausted ? 'FAILED' : 'PENDING',
        nextAttemptAt: exhausted ? null : nextAttemptAt,
        claimedAt: null,
        claimedBy: null,
      },
    });

    // Incremented in the database rather than from the value read before the
    // request. Two instances failing the same endpoint at the same time would
    // otherwise both write the same count and a genuinely broken endpoint would
    // take twice as long as it should to reach the suspension threshold.
    // A 429 is a receiver that is up and busy, not a broken one: it does not
    // count towards suspension. The delivery itself still uses an attempt.
    const bumped = await prisma.webhookEndpoint.update({
      where: { id: delivery.endpoint.id },
      data: rateLimited ? {} : { failureCount: { increment: 1 } },
      select: { failureCount: true },
    });

    const failureCount = bumped.failureCount;
    const shouldSuspend = !rateLimited && failureCount >= failureThreshold;

    // Only the delivery that crosses the threshold suspends: one that fails on
    // another instance after it finds the endpoint already suspended.
    const crossed = shouldSuspend
      ? (
          await prisma.webhookEndpoint.updateMany({
            where: { id: delivery.endpoint.id, suspendedAt: null },
            data: { suspendedAt: new Date(now.getTime() + suspensionWindowHours * 60 * 60 * 1000) },
          })
        ).count === 1
      : false;
    if (shouldSuspend) suspendedThisPass.add(delivery.endpoint.id);

    if (crossed) {
      await prisma.webhookDelivery.updateMany({
        where: { endpointId: delivery.endpoint.id, status: { in: ['PENDING', 'IN_FLIGHT'] } },
        data: { status: 'SUSPENDED', claimedAt: null, claimedBy: null },
      });
      const suspended = await prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: delivery.endpoint.id },
        select: { organizationId: true, name: true, url: true },
      });
      await recordAuditEvent({
        organizationId: suspended.organizationId,
        action: 'WEBHOOK_ENDPOINT_SUSPENDED',
        targetType: 'webhook_endpoint',
        targetId: delivery.endpoint.id,
        detail: { failures: failureCount, suspendedForHours: suspensionWindowHours },
      });
      await notifySuspension({ ...suspended, failures: failureCount, lastError: error ?? null });
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

export type ReplayOutcome = 'queued' | 'not_found' | 'endpoint_paused';

export async function replayDelivery(organizationId: string, deliveryId: string): Promise<ReplayOutcome> {
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id: deliveryId, organizationId },
    select: { id: true, endpoint: { select: { active: true } } },
  });
  if (!delivery) {
    return 'not_found';
  }

  /**
   * Send again is refused while the endpoint is paused.
   *
   * The worker holds a paused endpoint's deliveries, so queuing this one would
   * answer "queued" for something that is not going to be sent. Saying so is
   * the honest answer, and the operator's next step is plain: resume, then send
   * it again.
   */
  if (!delivery.endpoint.active) {
    return 'endpoint_paused';
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, responseCode: null },
  });

  return 'queued';
}

/**
 * Tells the workspace's owners and admins that an endpoint stopped itself.
 *
 * Without it a suspension was only an audit row: the receiving system went
 * quiet and nobody here knew why until they opened the delivery log. Once per
 * suspension, because the threshold is crossed once; a failure while already
 * suspended does not reach this code. Never throws: a notice that cannot be
 * written must not undo the suspension.
 */
async function notifySuspension(input: {
  organizationId: string;
  name: string;
  url: string;
  failures: number;
  lastError: string | null;
}): Promise<void> {
  const members = await prisma.member.findMany({
    where: { organizationId: input.organizationId, role: { in: ['owner', 'admin'] } },
    select: { userId: true },
  });
  if (members.length === 0) return;
  let host = input.url;
  try {
    host = new URL(input.url).host;
  } catch {
    // The stored URL was validated on the way in; the raw value is a fine fallback.
  }
  await prisma.notification
    .createMany({
      data: members.map((member) => ({
        userId: member.userId,
        organizationId: input.organizationId,
        kind: 'WEBHOOK' as const,
        severity: 'CRITICAL' as const,
        title: `Webhook ${input.name} suspended`,
        body: `${input.failures} deliveries to ${host} failed in a row, so nothing more is sent to it. ${input.lastError ? `The last answer: ${input.lastError} ` : ''}Its waiting deliveries are held. Fix the receiver, then resume the endpoint to send them.`,
        link: '/settings/webhooks',
      })),
      skipDuplicates: true,
    })
    .catch((caught: unknown) => {
      console.error(
        `[webhooks] could not create the suspension notice: ${caught instanceof Error ? caught.message : 'unknown error'}`,
      );
    });
}