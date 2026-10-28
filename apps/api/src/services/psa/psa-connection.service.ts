import { Prisma, type PsaConnection, type PsaProvider } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { isPrivateOrReservedHost } from '../net-guard.js';
import { decryptSensitive, encryptSensitive } from '../privacy.service.js';
import { recordAuditEvent } from '../audit.service.js';
import {
  PsaError,
  createPsaClient,
  type PsaCompany,
  type PsaCredentials,
  type PsaOptions,
  type PsaProviderClient,
  type PsaProviderName,
  type PsaTicketSettings,
} from './provider.js';
import { discoverAutotaskZone } from './providers/autotask.js';

/**
 * The connection, its mappings, and the one place a client is built.
 *
 * Everything that leaves this module is safe to show: the credentials are
 * decrypted only inside `clientFor`, which is called by the worker and by the
 * three routes that talk to the PSA. No view, export or audit detail ever
 * carries them.
 */

export class PsaConnectionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PsaConnectionError';
  }
}

export interface PsaConnectionView {
  id: string;
  provider: PsaProviderName;
  status: 'ACTIVE' | 'PAUSED';
  pausedReason: string | null;
  credentialHint: string;
  baseUrl: string;
  settings: PsaTicketSettings & {
    closeOnResolve: boolean;
    ticketOnAlert: boolean;
    ticketOnCriticalDns: boolean;
  };
  health: { lastSuccessAt: string | null; lastError: string | null; consecutiveFailures: number };
  version: number;
  createdAt: string;
}

export interface PsaMappingView {
  clientId: string;
  clientName: string;
  clientSlug: string;
  mapping: { externalCompanyId: string; externalCompanyName: string; updatedAt: string } | null;
}

export interface PsaView {
  /** False when this deployment has no PSA feature switched on at all. */
  available: boolean;
  providers: Array<{ provider: PsaProviderName; available: boolean; reason: string | null }>;
  connection: PsaConnectionView | null;
  skippedUnmapped: Array<{ clientId: string; clientName: string; count: number }>;
  ticketCounts: { open: number; closed: number };
}

export interface PsaJobView {
  id: string;
  kind: string;
  status: string;
  skipReason: string | null;
  attempts: number;
  lastError: string | null;
  reference: string;
  createdAt: string;
  doneAt: string | null;
  nextAttemptAt: string;
  ticket: { id: string; url: string | null; state: string } | null;
}

const providerNames: Record<PsaProvider, PsaProviderName> = {
  HALOPSA: 'HALOPSA',
  CONNECTWISE: 'CONNECTWISE',
  AUTOTASK: 'AUTOTASK',
};

/** Which providers this deployment can actually offer. */
export function psaProviderAvailability(): Array<{
  provider: PsaProviderName;
  available: boolean;
  reason: string | null;
}> {
  return [
    { provider: 'HALOPSA', available: true, reason: null },
    {
      provider: 'CONNECTWISE',
      available: Boolean(env.PSA_CONNECTWISE_CLIENT_ID),
      reason: env.PSA_CONNECTWISE_CLIENT_ID
        ? null
        : 'ConnectWise is not set up on this deployment: it needs PSA_CONNECTWISE_CLIENT_ID.',
    },
    { provider: 'AUTOTASK', available: true, reason: null },
  ];
}

export function assertProviderOffered(provider: PsaProviderName): void {
  const entry = psaProviderAvailability().find((candidate) => candidate.provider === provider);
  if (!entry?.available) {
    throw new PsaConnectionError(
      entry?.reason ?? 'That PSA is not offered on this deployment.',
      'PSA_PROVIDER_UNAVAILABLE',
      503,
    );
  }
}

// ─── URL validation ─────────────────────────────────────────────────────────

/**
 * A base URL the customer typed.
 *
 * Checked here as well as at request time: a value that can never work should
 * be refused while the form is open, not stored and then failed on every job.
 * `allowPath` is the one exception — Halo's auth server lives at `/auth`.
 */
export function validateHttpsBaseUrl(
  value: string,
  options: { allowPath?: string; label: string },
): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PsaConnectionError(`${options.label} must be a full URL, for example https://acme.halopsa.com.`, 'INVALID_CREDENTIALS', 400);
  }
  if (url.protocol !== 'https:') {
    throw new PsaConnectionError(`${options.label} must start with https://.`, 'INVALID_CREDENTIALS', 400);
  }
  if (url.username || url.password) {
    throw new PsaConnectionError(`${options.label} must not contain a username or password.`, 'INVALID_CREDENTIALS', 400);
  }
  if (isPrivateOrReservedHost(url.hostname)) {
    throw new PsaConnectionError(
      `${options.label} points at a private or reserved address, which this service will not call.`,
      'INVALID_CREDENTIALS',
      400,
    );
  }
  const path = url.pathname.replace(/\/+$/, '');
  const allowed = options.allowPath ?? '';
  if (path !== allowed && path !== '') {
    throw new PsaConnectionError(
      `${options.label} must not carry a path${allowed ? ` beyond ${allowed}` : ''}.`,
      'INVALID_CREDENTIALS',
      400,
    );
  }
  return `${url.origin}${allowed}`;
}

/** ConnectWise wants a bare hostname, not a URL. */
export function validateBareHostname(value: string, label: string): string {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) {
    throw new PsaConnectionError(
      `${label} must be a hostname such as api-na.myconnectwise.net, with no scheme and no path.`,
      'INVALID_CREDENTIALS',
      400,
    );
  }
  if (isPrivateOrReservedHost(host)) {
    throw new PsaConnectionError(
      `${label} points at a private or reserved address, which this service will not call.`,
      'INVALID_CREDENTIALS',
      400,
    );
  }
  return host;
}

// ─── credentials ────────────────────────────────────────────────────────────

const requiredFields: Record<PsaProviderName, string[]> = {
  HALOPSA: ['resourceServer', 'clientId', 'clientSecret'],
  CONNECTWISE: ['site', 'companyId', 'publicKey', 'privateKey'],
  AUTOTASK: ['username', 'secret', 'integrationCode'],
};

function requireFields(provider: PsaProviderName, credentials: PsaCredentials): void {
  for (const field of requiredFields[provider]) {
    if (!credentials[field]?.trim()) {
      throw new PsaConnectionError(
        `The ${field} field is required for this PSA.`,
        'INVALID_CREDENTIALS',
        400,
      );
    }
  }
}

/**
 * What the UI may show: the host, and the last four characters of the public
 * identifier. Never the secret, and never enough of the identifier to be one.
 */
export function credentialHintFor(provider: PsaProviderName, credentials: PsaCredentials, baseUrl: string): string {
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  })();
  const tail = (value: string | undefined): string => (value ?? '').slice(-4);
  switch (provider) {
    case 'HALOPSA':
      return `${host} · client ${tail(credentials.clientId)}`;
    case 'CONNECTWISE':
      return `${host} · member ${tail(credentials.publicKey)}`;
    case 'AUTOTASK':
      return `${host} · user ${tail(credentials.username)}`;
    default:
      return host;
  }
}

/** Resolves the stored base URL and normalises the credentials for one provider. */
async function resolveBaseUrl(provider: PsaProviderName, credentials: PsaCredentials): Promise<string> {
  switch (provider) {
    case 'HALOPSA': {
      const resourceServer = validateHttpsBaseUrl(credentials.resourceServer ?? '', {
        label: 'The Halo resource server',
      });
      const authServer = credentials.authServer?.trim()
        ? validateHttpsBaseUrl(credentials.authServer, {
            allowPath: '/auth',
            label: 'The Halo authorisation server',
          })
        : `${resourceServer}/auth`;
      credentials.authServer = authServer;
      return resourceServer;
    }
    case 'CONNECTWISE':
      return validateBareHostname(credentials.site ?? '', 'The ConnectWise site');
    case 'AUTOTASK':
      return discoverAutotaskZone(credentials.username ?? '');
    default:
      throw new PsaConnectionError('That PSA is not supported.', 'PSA_PROVIDER_UNAVAILABLE', 400);
  }
}

/** The client for a stored connection. The only place credentials are decrypted. */
export function clientFor(connection: PsaConnection): PsaProviderClient {
  const decrypted = decryptSensitive(connection.encryptedCredentials);
  if (!decrypted) {
    throw new PsaError(
      'The stored credentials could not be read. Replace them to reconnect.',
      'PSA_AUTH_FAILED',
      400,
    );
  }
  let credentials: PsaCredentials;
  try {
    credentials = JSON.parse(decrypted) as PsaCredentials;
  } catch {
    throw new PsaError(
      'The stored credentials could not be read. Replace them to reconnect.',
      'PSA_AUTH_FAILED',
      400,
    );
  }
  return createPsaClient(providerNames[connection.provider], {
    credentials,
    baseUrl: connection.baseUrl,
    settings: settingsOf(connection),
  });
}

function settingsOf(connection: PsaConnection): PsaTicketSettings {
  return {
    ticketQueueId: connection.ticketQueueId,
    ticketTypeId: connection.ticketTypeId,
    openStatusId: connection.openStatusId,
    closedStatusId: connection.closedStatusId,
    priorityId: connection.priorityId,
  };
}

// ─── view ───────────────────────────────────────────────────────────────────

export function connectionView(connection: PsaConnection): PsaConnectionView {
  return {
    id: connection.id,
    provider: providerNames[connection.provider],
    status: connection.status,
    pausedReason: connection.pausedReason,
    credentialHint: connection.credentialHint,
    baseUrl: connection.baseUrl,
    settings: {
      ...settingsOf(connection),
      closeOnResolve: connection.closeOnResolve,
      ticketOnAlert: connection.ticketOnAlert,
      ticketOnCriticalDns: connection.ticketOnCriticalDns,
    },
    health: {
      lastSuccessAt: connection.lastSuccessAt?.toISOString() ?? null,
      lastError: connection.lastError,
      consecutiveFailures: connection.consecutiveFailures,
    },
    version: connection.version,
    createdAt: connection.createdAt.toISOString(),
  };
}

export async function psaView(organizationId: string): Promise<PsaView> {
  const [connection, skipped, open, closed] = await Promise.all([
    prisma.psaConnection.findUnique({ where: { organizationId } }),
    prisma.psaTicketJob.findMany({
      where: { organizationId, status: 'SKIPPED', skipReason: 'unmapped_client' },
      select: { payload: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.psaTicketLink.count({ where: { organizationId, state: 'OPEN' } }),
    prisma.psaTicketLink.count({ where: { organizationId, state: 'CLOSED' } }),
  ]);

  const byClient = new Map<string, { clientId: string; clientName: string; count: number }>();
  for (const job of skipped) {
    const payload = (job.payload ?? {}) as { clientId?: unknown; clientName?: unknown };
    const clientId = typeof payload.clientId === 'string' ? payload.clientId : '';
    const clientName = typeof payload.clientName === 'string' ? payload.clientName : 'A client';
    if (!clientId) continue;
    const entry = byClient.get(clientId) ?? { clientId, clientName, count: 0 };
    entry.count += 1;
    byClient.set(clientId, entry);
  }

  return {
    available: true,
    providers: psaProviderAvailability(),
    connection: connection ? connectionView(connection) : null,
    skippedUnmapped: [...byClient.values()].sort((a, b) => b.count - a.count),
    ticketCounts: { open, closed },
  };
}

export async function connectionFor(organizationId: string): Promise<PsaConnection | null> {
  return prisma.psaConnection.findUnique({ where: { organizationId } });
}

// ─── save, patch, delete ────────────────────────────────────────────────────

export async function saveConnection(input: {
  organizationId: string;
  actorUserId: string;
  provider: PsaProviderName;
  credentials: PsaCredentials;
  settings?: Partial<PsaTicketSettings> & {
    closeOnResolve?: boolean;
    ticketOnAlert?: boolean;
    ticketOnCriticalDns?: boolean;
  };
}): Promise<PsaView> {
  assertProviderOffered(input.provider);
  requireFields(input.provider, input.credentials);

  const credentials = { ...input.credentials };
  // Zone discovery can refuse with a provider error (a zone outside
  // autotask.net), and the route answers connection errors, not provider ones.
  let baseUrl: string;
  try {
    baseUrl = await resolveBaseUrl(input.provider, credentials);
  } catch (error) {
    throw asConnectionError(error);
  }

  // Tested before anything is stored: a connection that cannot authenticate is
  // a promise the product cannot keep, and every job against it would fail.
  const client = createPsaClient(input.provider, {
    credentials,
    baseUrl,
    settings: {
      ticketQueueId: input.settings?.ticketQueueId ?? null,
      ticketTypeId: input.settings?.ticketTypeId ?? null,
      openStatusId: input.settings?.openStatusId ?? null,
      closedStatusId: input.settings?.closedStatusId ?? null,
      priorityId: input.settings?.priorityId ?? null,
    },
  });
  try {
    await client.test();
  } catch (error) {
    if (error instanceof PsaError) {
      throw new PsaConnectionError(error.message, error.code, error.status);
    }
    throw error;
  }

  const existing = await prisma.psaConnection.findUnique({ where: { organizationId: input.organizationId } });
  const providerChanged = Boolean(existing && existing.provider !== input.provider);

  const data = {
    provider: input.provider,
    status: 'ACTIVE' as const,
    pausedReason: null,
    encryptedCredentials: encryptSensitive(JSON.stringify(credentials)),
    credentialHint: credentialHintFor(input.provider, credentials, baseUrl),
    baseUrl,
    consecutiveFailures: 0,
    lastError: null,
    version: { increment: 1 },
    ...(input.settings?.ticketQueueId !== undefined ? { ticketQueueId: input.settings.ticketQueueId } : {}),
    ...(input.settings?.ticketTypeId !== undefined ? { ticketTypeId: input.settings.ticketTypeId } : {}),
    ...(input.settings?.openStatusId !== undefined ? { openStatusId: input.settings.openStatusId } : {}),
    ...(input.settings?.closedStatusId !== undefined ? { closedStatusId: input.settings.closedStatusId } : {}),
    ...(input.settings?.priorityId !== undefined ? { priorityId: input.settings.priorityId } : {}),
    ...(input.settings?.closeOnResolve !== undefined ? { closeOnResolve: input.settings.closeOnResolve } : {}),
    ...(input.settings?.ticketOnAlert !== undefined ? { ticketOnAlert: input.settings.ticketOnAlert } : {}),
    ...(input.settings?.ticketOnCriticalDns !== undefined
      ? { ticketOnCriticalDns: input.settings.ticketOnCriticalDns }
      : {}),
  };

  const connection = await prisma.psaConnection.upsert({
    where: { organizationId: input.organizationId },
    create: {
      organizationId: input.organizationId,
      provider: input.provider,
      encryptedCredentials: encryptSensitive(JSON.stringify(credentials)),
      credentialHint: credentialHintFor(input.provider, credentials, baseUrl),
      baseUrl,
      createdById: input.actorUserId,
      ticketQueueId: input.settings?.ticketQueueId ?? null,
      ticketTypeId: input.settings?.ticketTypeId ?? null,
      openStatusId: input.settings?.openStatusId ?? null,
      closedStatusId: input.settings?.closedStatusId ?? null,
      priorityId: input.settings?.priorityId ?? null,
      closeOnResolve: input.settings?.closeOnResolve ?? true,
      ticketOnAlert: input.settings?.ticketOnAlert ?? true,
      ticketOnCriticalDns: input.settings?.ticketOnCriticalDns ?? true,
    },
    update: data,
  });

  // A mapping names a company in one PSA. Keeping it across a provider change
  // would point at an id the new provider has never heard of.
  if (providerChanged) {
    await prisma.psaCompanyMapping.deleteMany({ where: { organizationId: input.organizationId } });
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: existing ? 'PSA_CONNECTION_UPDATED' : 'PSA_CONNECTION_CREATED',
    targetType: 'psa_connection',
    targetId: connection.id,
    detail: {
      provider: input.provider,
      host: new URL(baseUrl).host,
      ...(providerChanged ? { replacedProvider: existing?.provider, mappingsCleared: true } : {}),
    },
  });

  return psaView(input.organizationId);
}

export async function patchConnection(input: {
  organizationId: string;
  actorUserId: string;
  expectedVersion?: number;
  enabled?: boolean;
  settings?: {
    ticketQueueId?: string | null;
    ticketTypeId?: string | null;
    openStatusId?: string | null;
    closedStatusId?: string | null;
    priorityId?: string | null;
    closeOnResolve?: boolean;
    ticketOnAlert?: boolean;
    ticketOnCriticalDns?: boolean;
  };
}): Promise<PsaView> {
  const connection = await prisma.psaConnection.findUnique({
    where: { organizationId: input.organizationId },
  });
  if (!connection) {
    throw new PsaConnectionError('This workspace has no PSA connected.', 'NOT_CONNECTED', 404);
  }

  if (input.enabled !== undefined) {
    const next = await prisma.psaConnection.update({
      where: { id: connection.id },
      data: {
        status: input.enabled ? 'ACTIVE' : 'PAUSED',
        pausedReason: input.enabled ? null : (connection.pausedReason ?? 'Paused by an administrator.'),
        consecutiveFailures: input.enabled ? 0 : connection.consecutiveFailures,
        version: { increment: 1 },
      },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.enabled ? 'PSA_CONNECTION_RESUMED' : 'PSA_CONNECTION_PAUSED',
      targetType: 'psa_connection',
      targetId: next.id,
      detail: { provider: next.provider, host: new URL(next.baseUrl).host, by: 'workspace' },
    });
    return psaView(input.organizationId);
  }

  if (input.expectedVersion !== undefined && input.expectedVersion !== connection.version) {
    throw new PsaConnectionError(
      'Someone else changed this connection. Reload and try again.',
      'VERSION_CHANGED',
      409,
      { view: await psaView(input.organizationId) },
    );
  }

  const settings = input.settings ?? {};
  const updated = await prisma.psaConnection.updateMany({
    where: { id: connection.id, version: input.expectedVersion ?? connection.version },
    data: {
      ...(settings.ticketQueueId !== undefined ? { ticketQueueId: settings.ticketQueueId } : {}),
      ...(settings.ticketTypeId !== undefined ? { ticketTypeId: settings.ticketTypeId } : {}),
      ...(settings.openStatusId !== undefined ? { openStatusId: settings.openStatusId } : {}),
      ...(settings.closedStatusId !== undefined ? { closedStatusId: settings.closedStatusId } : {}),
      ...(settings.priorityId !== undefined ? { priorityId: settings.priorityId } : {}),
      ...(settings.closeOnResolve !== undefined ? { closeOnResolve: settings.closeOnResolve } : {}),
      ...(settings.ticketOnAlert !== undefined ? { ticketOnAlert: settings.ticketOnAlert } : {}),
      ...(settings.ticketOnCriticalDns !== undefined
        ? { ticketOnCriticalDns: settings.ticketOnCriticalDns }
        : {}),
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    throw new PsaConnectionError(
      'Someone else changed this connection. Reload and try again.',
      'VERSION_CHANGED',
      409,
      { view: await psaView(input.organizationId) },
    );
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'PSA_CONNECTION_UPDATED',
    targetType: 'psa_connection',
    targetId: connection.id,
    detail: { provider: connection.provider, host: new URL(connection.baseUrl).host, settings: Object.keys(settings) },
  });

  return psaView(input.organizationId);
}

export async function deleteConnection(input: {
  organizationId: string;
  actorUserId: string;
}): Promise<void> {
  const connection = await prisma.psaConnection.findUnique({
    where: { organizationId: input.organizationId },
  });
  if (!connection) {
    throw new PsaConnectionError('This workspace has no PSA connected.', 'NOT_CONNECTED', 404);
  }

  await prisma.psaConnection.delete({ where: { id: connection.id } });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'PSA_CONNECTION_REMOVED',
    targetType: 'psa_connection',
    targetId: connection.id,
    detail: { provider: connection.provider, host: new URL(connection.baseUrl).host },
  });
}

// ─── mappings ───────────────────────────────────────────────────────────────

export async function listMappings(organizationId: string): Promise<PsaMappingView[]> {
  const clients = await prisma.client.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      psaMapping: {
        select: { externalCompanyId: true, externalCompanyName: true, updatedAt: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  return clients.map((client) => ({
    clientId: client.id,
    clientName: client.name,
    clientSlug: client.slug,
    mapping: client.psaMapping
      ? {
          externalCompanyId: client.psaMapping.externalCompanyId,
          externalCompanyName: client.psaMapping.externalCompanyName,
          updatedAt: client.psaMapping.updatedAt.toISOString(),
        }
      : null,
  }));
}

export async function setMapping(input: {
  organizationId: string;
  actorUserId: string;
  clientId: string;
  externalCompanyId: string;
  externalCompanyName: string;
}): Promise<PsaMappingView[]> {
  const connection = await prisma.psaConnection.findUnique({
    where: { organizationId: input.organizationId },
  });
  if (!connection) {
    throw new PsaConnectionError('Connect a PSA before mapping clients.', 'NOT_CONNECTED', 404);
  }

  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { id: true, name: true },
  });
  if (!client) {
    throw new PsaConnectionError('That client is not in this workspace.', 'CLIENT_NOT_FOUND', 404);
  }
  if (!input.externalCompanyId.trim() || !input.externalCompanyName.trim()) {
    throw new PsaConnectionError(
      'Choose a company from the PSA.',
      'INVALID_MAPPING',
      400,
    );
  }

  await prisma.psaCompanyMapping.upsert({
    where: { clientId: client.id },
    create: {
      organizationId: input.organizationId,
      clientId: client.id,
      externalCompanyId: input.externalCompanyId.trim(),
      externalCompanyName: input.externalCompanyName.trim(),
      mappedById: input.actorUserId,
    },
    update: {
      externalCompanyId: input.externalCompanyId.trim(),
      externalCompanyName: input.externalCompanyName.trim(),
      mappedById: input.actorUserId,
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'PSA_MAPPING_CHANGED',
    targetType: 'client',
    targetId: client.id,
    detail: {
      provider: connection.provider,
      clientName: client.name,
      externalCompanyName: input.externalCompanyName.trim(),
    },
  });

  return listMappings(input.organizationId);
}

export async function removeMapping(input: {
  organizationId: string;
  actorUserId: string;
  clientId: string;
}): Promise<PsaMappingView[]> {
  const mapping = await prisma.psaCompanyMapping.findFirst({
    where: { clientId: input.clientId, organizationId: input.organizationId },
    select: { id: true, externalCompanyName: true, client: { select: { name: true } } },
  });
  if (!mapping) {
    return listMappings(input.organizationId);
  }

  await prisma.psaCompanyMapping.delete({ where: { id: mapping.id } });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'PSA_MAPPING_CHANGED',
    targetType: 'client',
    targetId: input.clientId,
    detail: { clientName: mapping.client.name, removed: true },
  });

  return listMappings(input.organizationId);
}

// ─── PSA calls the routes make ──────────────────────────────────────────────

export async function testConnection(organizationId: string): Promise<{ ok: boolean; detail: string }> {
  const connection = await prisma.psaConnection.findUnique({ where: { organizationId } });
  if (!connection) {
    throw new PsaConnectionError('This workspace has no PSA connected.', 'NOT_CONNECTED', 404);
  }
  const client = clientFor(connection);
  try {
    const result = await client.test();
    await prisma.psaConnection.update({
      where: { id: connection.id },
      data: { lastSuccessAt: new Date(), lastError: null, consecutiveFailures: 0 },
    });
    return { ok: true, detail: result.detail };
  } catch (error) {
    const message = error instanceof PsaError ? error.message : 'The PSA could not be reached.';
    await prisma.psaConnection
      .update({ where: { id: connection.id }, data: { lastError: message } })
      .catch(() => undefined);
    if (error instanceof PsaError) {
      throw new PsaConnectionError(message, error.code, error.status);
    }
    throw error;
  }
}

export async function psaOptions(organizationId: string): Promise<PsaOptions> {
  const connection = await prisma.psaConnection.findUnique({ where: { organizationId } });
  if (!connection) {
    throw new PsaConnectionError('This workspace has no PSA connected.', 'NOT_CONNECTED', 404);
  }
  try {
    return await clientFor(connection).options();
  } catch (error) {
    throw asConnectionError(error);
  }
}

export async function searchPsaCompanies(organizationId: string, query: string): Promise<PsaCompany[]> {
  const connection = await prisma.psaConnection.findUnique({ where: { organizationId } });
  if (!connection) {
    throw new PsaConnectionError('This workspace has no PSA connected.', 'NOT_CONNECTED', 404);
  }
  if (query.trim().length < 2) {
    throw new PsaConnectionError('Type at least two characters to search.', 'INVALID_QUERY', 400);
  }
  try {
    return await clientFor(connection).searchCompanies(query.trim());
  } catch (error) {
    throw asConnectionError(error);
  }
}

export function asConnectionError(error: unknown): PsaConnectionError {
  if (error instanceof PsaConnectionError) return error;
  if (error instanceof PsaError) {
    return new PsaConnectionError(error.message, error.code, error.status);
  }
  return new PsaConnectionError(
    'The PSA could not be reached.',
    'PSA_UNAVAILABLE',
    502,
  );
}

// ─── jobs ───────────────────────────────────────────────────────────────────

export async function listJobs(organizationId: string, limit: number): Promise<PsaJobView[]> {
  const rows = await prisma.psaTicketJob.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(limit, 1), 100),
  });

  const references = [...new Set(rows.map((row) => row.linkReference))];
  const links = references.length
    ? await prisma.psaTicketLink.findMany({
        where: { organizationId, reference: { in: references } },
        select: { reference: true, externalTicketId: true, externalTicketUrl: true, state: true },
      })
    : [];
  const linkByReference = new Map(links.map((link) => [link.reference, link]));

  return rows.map((row) => {
    const link = linkByReference.get(row.linkReference);
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      skipReason: row.skipReason,
      attempts: row.attempts,
      lastError: row.lastError,
      reference: row.linkReference,
      createdAt: row.createdAt.toISOString(),
      doneAt: row.doneAt?.toISOString() ?? null,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      ticket: link
        ? { id: link.externalTicketId, url: link.externalTicketUrl, state: link.state }
        : null,
    };
  });
}

export async function retryJob(input: {
  organizationId: string;
  actorUserId: string;
  jobId: string;
}): Promise<void> {
  const job = await prisma.psaTicketJob.findFirst({
    where: { id: input.jobId, organizationId: input.organizationId },
    select: { id: true, status: true },
  });
  if (!job) {
    throw new PsaConnectionError('That job is not in this workspace.', 'JOB_NOT_FOUND', 404);
  }
  if (job.status !== 'FAILED') {
    throw new PsaConnectionError(
      'Only a failed job can be retried.',
      'JOB_NOT_FAILED',
      409,
    );
  }
  await prisma.psaTicketJob.update({
    where: { id: job.id },
    data: {
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      claimedAt: null,
      claimedBy: null,
    },
  });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'PSA_CONNECTION_UPDATED',
    targetType: 'psa_job',
    targetId: job.id,
    detail: { retried: true },
  });
}

/** Prisma's Json input type, for payloads written by the queue. */
export type PsaPayload = Prisma.InputJsonValue;
