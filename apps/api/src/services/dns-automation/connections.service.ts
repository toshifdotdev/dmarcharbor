import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { decryptSensitive, encryptSensitive } from '../privacy.service.js';
import {
  createCloudflareClient,
  DnsAutomationError,
  type CloudflareClient,
} from './cloudflare.client.js';

export const maxDnsConnections = 5;

export class DnsConnectionError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_TOKEN' | 'CONNECTION_LIMIT' | 'CONNECTION_NOT_FOUND' | 'CONNECTION_UNREADABLE',
    readonly status: number,
  ) {
    super(message);
    this.name = 'DnsConnectionError';
  }
}

export interface DnsConnectionView {
  id: string;
  provider: 'CLOUDFLARE';
  label: string | null;
  tokenHint: string;
  accountName: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  paused: boolean;
  createdAt: string;
}

function view(
  row: {
    id: string;
    provider: 'CLOUDFLARE';
    label: string | null;
    tokenHint: string;
    accountName: string | null;
    lastVerifiedAt: Date | null;
    lastError: string | null;
    createdAt: Date;
  },
  paused: boolean,
): DnsConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    tokenHint: row.tokenHint,
    accountName: row.accountName,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastError: row.lastError,
    paused,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Cloudflare's Global API Key is 37 hex characters. It is account-wide. */
export function looksLikeGlobalApiKey(value: string): boolean {
  return /^[a-f0-9]{37}$/i.test(value.trim());
}

export async function listDnsConnections(organizationId: string): Promise<DnsConnectionView[]> {
  const [rows, entitlements] = await Promise.all([
    prisma.dnsProviderConnection.findMany({
      where: { organizationId },
      select: {
        id: true,
        provider: true,
        label: true,
        tokenHint: true,
        accountName: true,
        lastVerifiedAt: true,
        lastError: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    resolveEntitlements(organizationId),
  ]);

  const paused = !entitlements.features['dns.automation'];
  return rows.map((row) => view(row, paused));
}

export async function createDnsConnection(input: {
  organizationId: string;
  token: string;
  label?: string | null;
  actorUserId?: string | null;
  client?: CloudflareClient;
}): Promise<DnsConnectionView> {
  const token = input.token.trim();
  if (!token) {
    throw new DnsConnectionError('Paste a Cloudflare API Token.', 'INVALID_TOKEN', 400);
  }

  if (looksLikeGlobalApiKey(token)) {
    throw new DnsConnectionError(
      'That is a Cloudflare Global API Key, which gives access to the whole account. Create a scoped API Token instead: My Profile → API Tokens → Create Token, with Zone → DNS → Edit and Zone → Zone → Read on only the zones you want us to manage.',
      'INVALID_TOKEN',
      400,
    );
  }

  const count = await prisma.dnsProviderConnection.count({
    where: { organizationId: input.organizationId },
  });
  if (count >= maxDnsConnections) {
    throw new DnsConnectionError(
      `This workspace already has ${maxDnsConnections} Cloudflare connections, which is the most it can hold. Remove one before adding another.`,
      'CONNECTION_LIMIT',
      409,
    );
  }

  const client = input.client ?? createCloudflareClient({ token });
  let status: string;
  try {
    status = (await client.verifyToken()).status;
  } catch (error) {
    if (error instanceof DnsAutomationError) {
      throw error;
    }
    throw new DnsAutomationError(
      'Cloudflare could not be reached just now. Nothing was saved; try again in a few minutes.',
      'PROVIDER_UNAVAILABLE',
      502,
    );
  }

  if (status !== 'active') {
    throw new DnsConnectionError(
      `Cloudflare reports this token as ${status || 'not active'}. Create an active token and connect it again.`,
      'INVALID_TOKEN',
      400,
    );
  }

  const label = input.label?.trim().slice(0, 80) || null;
  const created = await prisma.dnsProviderConnection.create({
    data: {
      organizationId: input.organizationId,
      provider: 'CLOUDFLARE',
      label,
      encryptedToken: encryptSensitive(token),
      tokenHint: token.slice(-4),
      createdById: input.actorUserId ?? null,
      lastVerifiedAt: new Date(),
    },
    select: {
      id: true,
      provider: true,
      label: true,
      tokenHint: true,
      accountName: true,
      lastVerifiedAt: true,
      lastError: true,
      createdAt: true,
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'DNS_CONNECTION_CREATED',
    targetType: 'dns_connection',
    targetId: created.id,
    detail: { provider: created.provider, label: created.label },
  });

  return view(created, false);
}

export async function deleteDnsConnection(input: {
  organizationId: string;
  connectionId: string;
  actorUserId?: string | null;
}): Promise<void> {
  const row = await prisma.dnsProviderConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { id: true, provider: true, label: true },
  });

  if (!row) {
    throw new DnsConnectionError('That Cloudflare connection is not in this workspace.', 'CONNECTION_NOT_FOUND', 404);
  }

  await prisma.dnsProviderConnection.delete({ where: { id: row.id } });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'DNS_CONNECTION_REMOVED',
    targetType: 'dns_connection',
    targetId: row.id,
    detail: { provider: row.provider, label: row.label },
  });
}

export async function loadDnsConnectionSecret(input: {
  organizationId: string;
  connectionId: string;
}): Promise<{
  id: string;
  provider: 'CLOUDFLARE';
  label: string | null;
  accountName: string | null;
  token: string;
}> {
  const row = await prisma.dnsProviderConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: {
      id: true,
      provider: true,
      label: true,
      accountName: true,
      encryptedToken: true,
    },
  });

  if (!row) {
    throw new DnsConnectionError('That Cloudflare connection is not in this workspace.', 'CONNECTION_NOT_FOUND', 404);
  }

  const token = decryptSensitive(row.encryptedToken);
  if (!token) {
    throw new DnsConnectionError(
      'The stored Cloudflare token could not be read. Remove this connection and connect Cloudflare again.',
      'CONNECTION_UNREADABLE',
      409,
    );
  }

  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    accountName: row.accountName,
    token,
  };
}

export async function markDnsConnectionError(connectionId: string, message: string): Promise<void> {
  await prisma.dnsProviderConnection
    .update({
      where: { id: connectionId },
      data: { lastError: message.slice(0, 500) },
    })
    .catch(() => undefined);
}

export async function markDnsConnectionSuccess(input: {
  connectionId: string;
  accountName: string | null;
}): Promise<void> {
  await prisma.dnsProviderConnection
    .update({
      where: { id: input.connectionId },
      data: {
        lastError: null,
        lastVerifiedAt: new Date(),
        ...(input.accountName ? { accountName: input.accountName } : {}),
      },
    })
    .catch(() => undefined);
}
