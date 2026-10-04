import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from './audit.service.js';

export const apiKeyPrefix = 'dmh';
export const apiKeyTtlDays = 365;

export type ApiScope = 'read' | 'write';

const keyBytes = 32;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Hashes the whole presented key rather than a slice of it. Base64url secrets
 * can themselves contain underscores, so locating a separator inside the value
 * is ambiguous and would silently reject a share of valid keys. Hashing the
 * exact string removes the parsing entirely.
 */
export function hashApiKey(presentedKey: string): string {
  return sha256(presentedKey);
}

export interface IssuedApiKey {
  id: string;
  name: string;
  /** Shown in the interface so a human can tell keys apart. */
  prefix: string;
  /** Returned exactly once. Never stored, never retrievable again. */
  key: string;
  scopes: ApiScope[];
  expiresAt: string;
}

export async function createApiKey(input: {
  organizationId: string;
  name: string;
  scopes: ApiScope[];
  createdById?: string | null;
  expiresInDays?: number | null;
}): Promise<IssuedApiKey> {
  const secret = randomBytes(keyBytes).toString('base64url');
  const prefix = `${apiKeyPrefix}_${secret.slice(0, 8)}`;
  const fullKey = `${prefix}_${secret}`;
  const expiresAt = new Date(Date.now() + (input.expiresInDays ?? apiKeyTtlDays) * 24 * 60 * 60 * 1000);

  const row = await prisma.apiKey.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      prefix,
      keyHash: sha256(fullKey),
      scopes: input.scopes,
      expiresAt,
      createdById: input.createdById ?? null,
    },
    select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.createdById ?? undefined,
    action: 'API_KEY_CREATED',
    targetType: 'api_key',
    targetId: row.id,
    detail: { name: row.name, scopes: input.scopes, prefix: row.prefix },
  });

  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    key: fullKey,
    scopes: input.scopes,
    expiresAt: (row.expiresAt ?? expiresAt).toISOString(),
  };
}

export interface VerifiedApiKey {
  id: string;
  organizationId: string;
  name: string;
  scopes: ApiScope[];
}

/**
 * Resolves a presented key. The stored value is a hash, so a database read
 * cannot recover a usable key, and the comparison is constant time so a
 * partially correct guess cannot be detected by timing.
 */
export async function verifyApiKey(presented: string, now = new Date()): Promise<VerifiedApiKey | null> {
  if (presented.length < 32) {
    return null;
  }

  const candidate = sha256(presented);
  const row = await prisma.apiKey.findUnique({ where: { keyHash: candidate } });
  if (!row) {
    return null;
  }

  const stored = Buffer.from(row.keyHash, 'hex');
  const supplied = Buffer.from(candidate, 'hex');
  if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) {
    return null;
  }

  if (row.revokedAt) {
    return null;
  }

  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    scopes: row.scopes as ApiScope[],
  };
}

export async function touchApiKey(keyId: string, ipAddress: string | null, now = new Date()): Promise<void> {
  await prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: now, lastUsedIp: ipAddress } });
}

export async function listApiKeys(organizationId: string) {
  return prisma.apiKey.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      lastUsedAt: true,
      lastUsedIp: true,
      revokedAt: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function revokeApiKey(
  organizationId: string,
  keyId: string,
  actorUserId?: string | null,
): Promise<boolean> {
  const existing = await prisma.apiKey.findFirst({
    where: { id: keyId, organizationId, revokedAt: null },
    select: { id: true, name: true },
  });

  if (!existing) {
    return false;
  }

  await prisma.apiKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });

  await recordAuditEvent({
    organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'API_KEY_REVOKED',
    targetType: 'api_key',
    targetId: existing.id,
    detail: { name: existing.name },
  });

  return true;
}

export const idempotencyTtlHours = 24;

/**
 * Looks up a stored response for an idempotent retry.
 *
 * Scoped to the caller's workspace. This read used to be keyed on `key` alone,
 * because `key` was globally unique, which merged every customer's retry
 * namespace into one. The caller then compared `organizationId` and refused to
 * replay on a mismatch, but by then the second workspace had already overwritten
 * the first workspace's stored body through `saveIdempotentResult`, whose update
 * branch left `organizationId` untouched. The first workspace's next retry passed
 * the ownership check and replayed the second workspace's payload, including its
 * client ids and DNS verification values.
 *
 * Also returns the stored request hash, which was previously recorded and never
 * compared: a different payload sent under a reused key returned the earlier
 * response instead of a conflict.
 */
export async function findIdempotentResult(organizationId: string, key: string) {
  const record = await prisma.idempotencyRecord.findUnique({
    where: { organizationId_key: { organizationId, key } },
    select: { organizationId: true, requestHash: true, statusCode: true, responseBody: true, createdAt: true },
  });

  if (!record) {
    return null;
  }

  const age = Date.now() - record.createdAt.getTime();
  if (age > idempotencyTtlHours * 60 * 60 * 1000) {
    return null;
  }

  return record;
}

export async function saveIdempotentResult(input: {
  key: string;
  organizationId: string;
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
}): Promise<void> {
  // The upsert writes every column, `organizationId` included. It cannot now
  // update a row belonging to a different workspace, because the unique key it
  // matches on includes it.
  await prisma.idempotencyRecord.upsert({
    where: { organizationId_key: { organizationId: input.organizationId, key: input.key } },
    create: {
      key: input.key,
      organizationId: input.organizationId,
      requestHash: input.requestHash,
      statusCode: input.statusCode,
      responseBody: input.responseBody as never,
    },
    update: {
      requestHash: input.requestHash,
      statusCode: input.statusCode,
      responseBody: input.responseBody as never,
    },
  });
}

export async function purgeExpiredIdempotencyRecords(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - idempotencyTtlHours * 60 * 60 * 1000);
  const { count } = await prisma.idempotencyRecord.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
