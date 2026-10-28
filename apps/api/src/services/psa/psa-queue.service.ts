import type { PsaConnection, PsaJobKind } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { PsaError } from './provider.js';
import {
  buildTicketTitle,
  newTicketReference,
  referenceMarker,
  titleLimits,
  type PsaProviderName,
} from './provider.js';
import { clientFor } from './psa-connection.service.js';

/**
 * The outbox.
 *
 * Two halves that never touch each other: `enqueue*` runs inside somebody
 * else's transaction-shaped code (an alert tick, a DNS monitoring pass) and
 * only ever inserts a row; `runPsaDelivery` is the only thing that calls a PSA.
 *
 * That split is the whole design. An alert tick that talked to HaloPSA would
 * hold the alert open for the length of a third-party request, fail the alert
 * when the PSA was down, and make the ladder's timing depend on someone else's
 * uptime. A row costs nothing and the worker retries it.
 */

export const psaMaxAttempts = 5;
export const psaRetryDelaysMinutes = [1, 5, 30, 120, 720];
/** A claim is abandoned after the request timeout plus a minute. */
const claimLeaseMs = 15_000 + 60_000;
const batchSize = 50;
/** After this many consecutive failures the connection is paused. */
const pauseAfterFailures = 20;

export interface PsaDeliveryOutcome {
  processed: number;
  opened: number;
  noted: number;
  closed: number;
  retry: number;
  failed: number;
  skipped: number;
  paused: number;
}

// ─── enqueue ────────────────────────────────────────────────────────────────

interface AlertContext {
  organizationId: string;
  eventId: string;
  ruleName: string;
  metric: string;
  observed: number;
  threshold: number;
  summary: string;
  domain: { id: string; name: string; slug: string; clientId: string; client: { name: string } };
  now?: Date;
}

interface ConnectionForEnqueue {
  id: string;
  provider: PsaProviderName;
  ticketOnAlert: boolean;
  ticketOnCriticalDns: boolean;
  closeOnResolve: boolean;
}

async function connectionForEnqueue(organizationId: string): Promise<ConnectionForEnqueue | null> {
  const connection = await prisma.psaConnection.findUnique({
    where: { organizationId },
    select: {
      id: true,
      provider: true,
      status: true,
      ticketOnAlert: true,
      ticketOnCriticalDns: true,
      closeOnResolve: true,
    },
  });
  if (!connection || connection.status !== 'ACTIVE') return null;
  return connection;
}

async function psaEntitled(organizationId: string): Promise<boolean> {
  const entitlements = await resolveEntitlements(organizationId);
  return entitlements.features['integrations.psa'] === true;
}

async function mappingFor(clientId: string) {
  return prisma.psaCompanyMapping.findUnique({
    where: { clientId },
    select: { externalCompanyId: true, externalCompanyName: true },
  });
}

/** Insert-or-ignore on the dedupe key, so two replicas produce one job. */
async function enqueueJob(input: {
  organizationId: string;
  connectionId: string;
  kind: PsaJobKind;
  dedupeKey: string;
  linkReference: string;
  payload: Prisma.InputJsonValue;
  status?: 'PENDING' | 'SKIPPED';
  skipReason?: string;
}): Promise<boolean> {
  const created = await prisma.psaTicketJob.createMany({
    data: [
      {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        linkReference: input.linkReference,
        payload: input.payload,
        status: input.status ?? 'PENDING',
        skipReason: input.skipReason ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return created.count > 0;
}

function alertBody(input: AlertContext, workspaceName: string): string {
  const lines = [
    input.summary,
    '',
    `Workspace: ${workspaceName}`,
    `Client: ${input.domain.client.name}`,
    `Domain: ${input.domain.name}`,
    `Rule: ${input.ruleName}`,
    `Metric: ${input.metric} (observed ${input.observed}, threshold ${input.threshold})`,
    '',
    `Open in DMARC Harbor: ${env.APP_URL.replace(/\/$/, '')}/alerts`,
  ];
  return lines.join('\n');
}

/**
 * An alert opened.
 *
 * Never throws: the caller wraps this in its own try/catch, and a PSA problem
 * must not stop an alert from existing.
 */
export async function enqueueAlertOpened(input: AlertContext): Promise<void> {
  const connection = await connectionForEnqueue(input.organizationId);
  if (!connection || !connection.ticketOnAlert) return;
  if (!(await psaEntitled(input.organizationId))) return;

  const reference = newTicketReference();
  const marker = referenceMarker(reference);
  const mapping = await mappingFor(input.domain.clientId);
  const workspace = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { name: true },
  });

  const payload = {
    title: buildTicketTitle({
      domain: input.domain.name,
      summary: input.summary,
      reference,
      limit: titleLimits[connection.provider],
    }),
    body: alertBody(input, workspace?.name ?? 'your workspace'),
    reference,
    marker,
    companyId: mapping?.externalCompanyId ?? null,
    companyName: mapping?.externalCompanyName ?? null,
    clientId: input.domain.clientId,
    clientName: input.domain.client.name,
    domainId: input.domain.id,
    domainName: input.domain.name,
    domainSlug: input.domain.slug,
    alertEventId: input.eventId,
  };

  await enqueueJob({
    organizationId: input.organizationId,
    connectionId: connection.id,
    kind: 'OPEN',
    dedupeKey: `alert:${input.eventId}:open`,
    linkReference: reference,
    payload,
    ...(mapping ? {} : { status: 'SKIPPED' as const, skipReason: 'unmapped_client' }),
  });
}

/** Resolves the reference of the ticket an alert event was opened under. */
async function referenceForAlertEvent(organizationId: string, eventId: string): Promise<string | null> {
  const open = await prisma.psaTicketJob.findUnique({
    where: { dedupeKey: `alert:${eventId}:open` },
    select: { linkReference: true, organizationId: true },
  });
  if (!open || open.organizationId !== organizationId) return null;
  return open.linkReference;
}

export async function enqueueAlertNote(input: {
  organizationId: string;
  eventId: string;
  text: string;
  /** Distinguishes a reminder level from an acknowledgement. */
  suffix: string;
}): Promise<void> {
  const connection = await connectionForEnqueue(input.organizationId);
  if (!connection) return;
  const reference = await referenceForAlertEvent(input.organizationId, input.eventId);
  if (!reference) return;

  await enqueueJob({
    organizationId: input.organizationId,
    connectionId: connection.id,
    kind: 'NOTE',
    dedupeKey: `alert:${input.eventId}:note:${input.suffix}`,
    linkReference: reference,
    payload: { text: input.text },
  });
}

export async function enqueueAlertClosed(input: {
  organizationId: string;
  eventId: string;
  text: string;
}): Promise<void> {
  const connection = await connectionForEnqueue(input.organizationId);
  if (!connection) return;
  const reference = await referenceForAlertEvent(input.organizationId, input.eventId);
  if (!reference) return;

  await enqueueJob({
    organizationId: input.organizationId,
    connectionId: connection.id,
    kind: 'NOTE',
    dedupeKey: `alert:${input.eventId}:note:resolved`,
    linkReference: reference,
    payload: { text: input.text },
  });

  if (connection.closeOnResolve) {
    await enqueueJob({
      organizationId: input.organizationId,
      connectionId: connection.id,
      kind: 'CLOSE',
      dedupeKey: `alert:${input.eventId}:close`,
      linkReference: reference,
      payload: {},
    });
  }
}

/**
 * Critical DNS changes, one ticket per domain per notification pass.
 *
 * The pass is identified by `notifiedAt`, which the claim already set: that is
 * what makes the dedupe key stable across replicas and across a retry of the
 * same pass, while a genuinely new pass gets its own ticket.
 */
export async function enqueueDnsChangesOpened(input: {
  organizationId: string;
  domain: { id: string; name: string; slug: string; clientId: string; client: { name: string } };
  changes: Array<{ id: string; summary: string }>;
  notifiedAt: Date;
}): Promise<void> {
  if (input.changes.length === 0) return;
  const connection = await connectionForEnqueue(input.organizationId);
  if (!connection || !connection.ticketOnCriticalDns) return;
  if (!(await psaEntitled(input.organizationId))) return;

  const reference = newTicketReference();
  const mapping = await mappingFor(input.domain.clientId);
  const workspace = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { name: true },
  });
  const first = input.changes[0]!.summary;
  const extra = input.changes.length > 1 ? ` (+${input.changes.length - 1} more)` : '';
  const listed = input.changes.slice(0, 20).map((change) => `- ${change.summary}`);

  const payload = {
    title: buildTicketTitle({
      domain: input.domain.name,
      summary: `${first}${extra}`,
      reference,
      limit: titleLimits[connection.provider],
    }),
    body: [
      `${input.changes.length} critical DNS change${input.changes.length === 1 ? '' : 's'} detected on ${input.domain.name}:`,
      '',
      ...listed,
      ...(input.changes.length > 20 ? [`- and ${input.changes.length - 20} more`] : []),
      '',
      `Workspace: ${workspace?.name ?? 'your workspace'}`,
      `Client: ${input.domain.client.name}`,
      '',
      `Review in DMARC Harbor: ${env.APP_URL.replace(/\/$/, '')}/domains/${input.domain.slug}`,
    ].join('\n'),
    reference,
    marker: referenceMarker(reference),
    companyId: mapping?.externalCompanyId ?? null,
    companyName: mapping?.externalCompanyName ?? null,
    clientId: input.domain.clientId,
    clientName: input.domain.client.name,
    domainId: input.domain.id,
    domainName: input.domain.name,
    domainSlug: input.domain.slug,
    dnsChangeIds: input.changes.map((change) => change.id),
  };

  await enqueueJob({
    organizationId: input.organizationId,
    connectionId: connection.id,
    kind: 'OPEN',
    dedupeKey: `dns:${input.domain.id}:${input.notifiedAt.toISOString()}:open`,
    linkReference: reference,
    payload,
    ...(mapping ? {} : { status: 'SKIPPED' as const, skipReason: 'unmapped_client' }),
  });
}

/**
 * A DNS change was acknowledged.
 *
 * Notes the ticket that covers it, and closes when every change on that ticket
 * has been acknowledged and the connection asks for that.
 */
export async function enqueueDnsChangeAcknowledged(input: {
  organizationId: string;
  changeId: string;
  changeSummary: string;
  actorName: string | null;
}): Promise<void> {
  const connection = await connectionForEnqueue(input.organizationId);
  if (!connection) return;

  const link = await prisma.psaTicketLink.findFirst({
    where: { organizationId: input.organizationId, dnsChangeIds: { has: input.changeId } },
    select: { reference: true, dnsChangeIds: true, state: true },
  });
  if (!link) return;

  await enqueueJob({
    organizationId: input.organizationId,
    connectionId: connection.id,
    kind: 'NOTE',
    dedupeKey: `dns:${link.reference}:note:ack:${input.changeId}`,
    linkReference: link.reference,
    payload: {
      text: `Acknowledged in DMARC Harbor${input.actorName ? ` by ${input.actorName}` : ''}: ${input.changeSummary}`,
    },
  });

  if (!connection.closeOnResolve || link.state === 'CLOSED') return;

  const outstanding = await prisma.dnsChange.count({
    where: { id: { in: link.dnsChangeIds }, acknowledgedAt: null },
  });
  if (outstanding === 0) {
    await enqueueJob({
      organizationId: input.organizationId,
      connectionId: connection.id,
      kind: 'CLOSE',
      dedupeKey: `dns:${link.reference}:close`,
      linkReference: link.reference,
      payload: {},
    });
  }
}

// ─── the worker ─────────────────────────────────────────────────────────────

function instanceId(): string {
  return process.env.HOSTNAME?.slice(0, 60) ?? 'psa-worker';
}

interface ClaimedJob {
  id: string;
  organizationId: string;
  connectionId: string;
  kind: PsaJobKind;
  linkReference: string;
  payload: unknown;
  attempts: number;
}

function payloadOf(job: ClaimedJob): Record<string, unknown> {
  return (job.payload ?? {}) as Record<string, unknown>;
}

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Marks a connection paused, audits it, and tells the owners. */
async function pauseConnection(input: {
  connection: PsaConnection;
  reason: string;
  actorUserId?: string | null;
}): Promise<void> {
  const paused = await prisma.psaConnection.update({
    where: { id: input.connection.id },
    data: {
      status: 'PAUSED',
      pausedReason: input.reason,
      lastError: input.reason,
    },
  });

  await recordAuditEvent({
    organizationId: paused.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'PSA_CONNECTION_PAUSED',
    targetType: 'psa_connection',
    targetId: paused.id,
    detail: { provider: paused.provider, host: new URL(paused.baseUrl).host, reason: input.reason },
  });

  const members = await prisma.member.findMany({
    where: { organizationId: paused.organizationId, role: { in: ['owner', 'admin'] } },
    select: { userId: true },
  });
  if (members.length === 0) return;

  await prisma.notification
    .createMany({
      data: members.map((member) => ({
        userId: member.userId,
        organizationId: paused.organizationId,
        kind: 'PSA' as const,
        severity: 'CRITICAL' as const,
        title: 'PSA ticketing paused',
        body: `DMARC Harbor stopped creating tickets in your PSA. ${input.reason}`,
        link: '/settings/psa',
      })),
      skipDuplicates: true,
    })
    .catch((error: unknown) => {
      console.error(
        `[psa] could not create the pause notification: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
}

async function recordFailure(input: {
  connection: PsaConnection;
  error: PsaError | Error;
}): Promise<'retry' | 'failed' | 'paused'> {
  const message = input.error.message;
  const code = input.error instanceof PsaError ? input.error.code : 'PSA_UNAVAILABLE';
  const credentialsBad = code === 'PSA_AUTH_FAILED' || code === 'PSA_PERMISSION_DENIED';

  const updated = await prisma.psaConnection.update({
    where: { id: input.connection.id },
    data: { lastError: message, consecutiveFailures: { increment: 1 } },
    select: { consecutiveFailures: true, status: true },
  });

  if (credentialsBad) {
    await pauseConnection({
      connection: input.connection,
      reason: `The PSA rejected the stored credentials, so retrying cannot help. ${message}`,
    });
    return 'paused';
  }

  if (updated.consecutiveFailures >= pauseAfterFailures && updated.status === 'ACTIVE') {
    await pauseConnection({
      connection: input.connection,
      reason: `The PSA failed ${updated.consecutiveFailures} times in a row. Last error: ${message}`,
    });
    return 'paused';
  }

  return 'retry';
}

async function linkFor(organizationId: string, reference: string) {
  return prisma.psaTicketLink.findUnique({
    where: { reference },
    select: { id: true, externalTicketId: true, state: true, organizationId: true },
  });
}

/**
 * Whether a NOTE or CLOSE should wait for its OPEN.
 *
 * A note cannot be added to a ticket that does not exist yet, and a close
 * cannot close one. The OPEN is earlier in the queue by construction, so this
 * is only ever a short wait — except when the OPEN failed, in which case the
 * note has nowhere to go and is skipped rather than retried forever.
 */
async function openStateFor(reference: string): Promise<'done' | 'pending' | 'dead'> {
  const open = await prisma.psaTicketJob.findFirst({
    where: { linkReference: reference, kind: 'OPEN' },
    select: { status: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!open) return 'dead';
  if (open.status === 'DONE') return 'done';
  if (open.status === 'PENDING' || open.status === 'IN_FLIGHT') return 'pending';
  return 'dead';
}

async function executeJob(input: {
  job: ClaimedJob;
  connection: PsaConnection;
  now: Date;
}): Promise<{ outcome: 'opened' | 'noted' | 'closed' | 'deferred' | 'skipped'; reason?: string }> {
  const client = clientFor(input.connection);
  const payload = payloadOf(input.job);
  const reference = input.job.linkReference;

  if (input.job.kind === 'OPEN') {
    const existing = await linkFor(input.job.organizationId, reference);
    if (existing) {
      // Already opened: a retry that got this far after a crash must not create
      // a second ticket.
      return { outcome: 'opened' };
    }

    const companyId = textOf(payload.companyId);
    if (!companyId) {
      return { outcome: 'skipped', reason: 'unmapped_client' };
    }

    /**
     * The lost-response case.
     *
     * The first attempt does not search: nothing can exist yet, and a search is
     * a wasted call on the happy path. Every retry searches first, because the
     * only reason to be here twice is that the first call may have succeeded
     * without us hearing about it.
     */
    if (input.job.attempts > 0) {
      const found = await client.findTicketByReference(companyId, reference);
      if (found) {
        await prisma.psaTicketLink.create({
          data: {
            organizationId: input.job.organizationId,
            connectionId: input.connection.id,
            provider: input.connection.provider,
            source: Array.isArray(payload.dnsChangeIds) ? 'DNS_CHANGES' : 'ALERT_EVENT',
            alertEventId: textOf(payload.alertEventId) || null,
            domainId: textOf(payload.domainId) || null,
            dnsChangeIds: Array.isArray(payload.dnsChangeIds)
              ? (payload.dnsChangeIds.filter((id): id is string => typeof id === 'string') as string[])
              : [],
            externalTicketId: found.id,
            externalTicketUrl: found.url,
            reference,
          },
        });
        return { outcome: 'opened' };
      }
    }

    const created = await client.createTicket({
      companyId,
      title: textOf(payload.title, `DMARC Harbor ${referenceMarker(reference)}`),
      body: textOf(payload.body),
      reference,
      settings: {
        ticketQueueId: input.connection.ticketQueueId,
        ticketTypeId: input.connection.ticketTypeId,
        openStatusId: input.connection.openStatusId,
        closedStatusId: input.connection.closedStatusId,
        priorityId: input.connection.priorityId,
      },
    });

    await prisma.psaTicketLink.create({
      data: {
        organizationId: input.job.organizationId,
        connectionId: input.connection.id,
        provider: input.connection.provider,
        source: Array.isArray(payload.dnsChangeIds) ? 'DNS_CHANGES' : 'ALERT_EVENT',
        alertEventId: textOf(payload.alertEventId) || null,
        domainId: textOf(payload.domainId) || null,
        dnsChangeIds: Array.isArray(payload.dnsChangeIds)
          ? (payload.dnsChangeIds.filter((id): id is string => typeof id === 'string') as string[])
          : [],
        externalTicketId: created.id,
        externalTicketUrl: created.url,
        reference,
      },
    });
    return { outcome: 'opened' };
  }

  const link = await linkFor(input.job.organizationId, reference);
  if (!link) {
    const state = await openStateFor(reference);
    if (state === 'pending') return { outcome: 'deferred' };
    return { outcome: 'skipped', reason: 'ticket_not_opened' };
  }

  if (input.job.kind === 'NOTE') {
    await client.addNote(link.externalTicketId, textOf(payload.text, 'Update from DMARC Harbor.'));
    return { outcome: 'noted' };
  }

  if (link.state === 'CLOSED') {
    return { outcome: 'closed' };
  }
  const closedStatusId = input.connection.closedStatusId;
  if (!closedStatusId) {
    return { outcome: 'skipped', reason: 'no_closed_status' };
  }
  await client.closeTicket(link.externalTicketId, closedStatusId);
  await prisma.psaTicketLink.update({
    where: { id: link.id },
    data: { state: 'CLOSED', closedAt: input.now },
  });
  return { outcome: 'closed' };
}

/**
 * One delivery pass.
 *
 * Jobs are grouped by connection and each connection is drained in order, one
 * job at a time: Autotask allows three concurrent threads per endpoint and
 * about ten thousand requests an hour, and serial per connection stays far
 * inside that for all three providers while keeping a note behind its ticket.
 */
export async function runPsaDelivery(now = new Date()): Promise<PsaDeliveryOutcome> {
  const outcome: PsaDeliveryOutcome = {
    processed: 0,
    opened: 0,
    noted: 0,
    closed: 0,
    retry: 0,
    failed: 0,
    skipped: 0,
    paused: 0,
  };

  await prisma.psaTicketJob.updateMany({
    where: { status: 'IN_FLIGHT', claimedAt: { lt: new Date(now.getTime() - claimLeaseMs) } },
    data: { status: 'PENDING', claimedAt: null, claimedBy: null },
  });

  const due = await prisma.psaTicketJob.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    select: { id: true, connectionId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: batchSize,
  });
  if (due.length === 0) return outcome;

  const byConnection = new Map<string, string[]>();
  for (const job of due) {
    byConnection.set(job.connectionId, [...(byConnection.get(job.connectionId) ?? []), job.id]);
  }

  for (const [connectionId, jobIds] of byConnection) {
    const connection = await prisma.psaConnection.findUnique({ where: { id: connectionId } });
    if (!connection) continue;
    if (connection.status !== 'ACTIVE') {
      // A paused connection keeps its queue: resuming should deliver what was
      // waiting, not silently drop it.
      continue;
    }

    for (const jobId of jobIds) {
      const claim = await prisma.psaTicketJob.updateMany({
        where: { id: jobId, status: 'PENDING' },
        data: { status: 'IN_FLIGHT', claimedAt: now, claimedBy: instanceId() },
      });
      if (claim.count !== 1) continue;

      const job = await prisma.psaTicketJob.findUnique({ where: { id: jobId } });
      if (!job) continue;
      outcome.processed += 1;

      try {
        const result = await executeJob({ job, connection, now });
        if (result.outcome === 'deferred') {
          await prisma.psaTicketJob.update({
            where: { id: job.id },
            data: {
              status: 'PENDING',
              nextAttemptAt: new Date(now.getTime() + 30_000),
              claimedAt: null,
              claimedBy: null,
            },
          });
          continue;
        }
        if (result.outcome === 'skipped') {
          await prisma.psaTicketJob.update({
            where: { id: job.id },
            data: {
              status: 'SKIPPED',
              skipReason: result.reason ?? 'not_applicable',
              doneAt: now,
              claimedAt: null,
              claimedBy: null,
            },
          });
          outcome.skipped += 1;
          continue;
        }

        await prisma.psaTicketJob.update({
          where: { id: job.id },
          data: { status: 'DONE', doneAt: now, claimedAt: null, claimedBy: null, lastError: null },
        });
        if (result.outcome === 'opened') outcome.opened += 1;
        if (result.outcome === 'noted') outcome.noted += 1;
        if (result.outcome === 'closed') outcome.closed += 1;

        await prisma.psaConnection.update({
          where: { id: connection.id },
          data: { lastSuccessAt: now, lastError: null, consecutiveFailures: 0 },
        });
      } catch (error) {
        const attempts = job.attempts + 1;
        const failure = error instanceof Error ? error : new Error('The PSA refused the request.');
        const pause = await recordFailure({ connection, error: failure });
        if (pause === 'paused') {
          outcome.paused += 1;
        }

        if (pause === 'paused' || attempts >= psaMaxAttempts) {
          await prisma.psaTicketJob.update({
            where: { id: job.id },
            data: {
              status: 'FAILED',
              attempts,
              lastError: error instanceof Error ? error.message : 'The PSA refused the request.',
              claimedAt: null,
              claimedBy: null,
            },
          });
          outcome.failed += 1;
          continue;
        }

        const retryAfter =
          error instanceof PsaError && error.code === 'PSA_RATE_LIMITED' ? error.retryAfterSeconds : undefined;
        const delayMinutes =
          retryAfter !== undefined
            ? Math.min(retryAfter / 60, 60)
            : psaRetryDelaysMinutes[Math.min(attempts - 1, psaRetryDelaysMinutes.length - 1)]!;

        await prisma.psaTicketJob.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            attempts,
            nextAttemptAt: new Date(now.getTime() + delayMinutes * 60_000),
            lastError: error instanceof Error ? error.message : 'The PSA refused the request.',
            claimedAt: null,
            claimedBy: null,
          },
        });
        outcome.retry += 1;
      }
    }
  }

  return outcome;
}
