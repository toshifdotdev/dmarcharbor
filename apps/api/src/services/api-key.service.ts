import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from './audit.service.js';

export const apiKeyPrefix = 'dmh';
export const apiKeyTtlDays = 365;

export type ApiScope = 'read' | 'write';

const keyBytes = 32;

/**
 * A key name that a live key in this workspace already uses.
 *
 * Thrown rather than returned, so the caller cannot forget to check it. The
 * `code` is what the browser routes on and the `status` is 409: the request is
 * well-formed, it just collides with something that exists.
 */
export class ApiKeyNameTakenError extends Error {
  readonly status = 409;
  readonly code = 'API_KEY_NAME_TAKEN';
  readonly name: string;

  constructor(name: string) {
    super(`A key called "${name}" already exists. Choose a different name, or revoke that key first.`);
    this.name = name;
    this.name_short = name;
  }

  /** Present for symmetry with the other error shapes; see `name`. */
  readonly name_short: string;
}

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

  /**
   * A name has to be unique in the workspace, and it was not.
   *
   * The list showed two rows both called "my-key", both readable only by
   * prefix, so the only way to tell them apart was the creation date. The
   * operator had to guess which one to revoke, and a wrong guess revokes a key
   * that is in use — which fails their integration, not the duplicate.
   *
   * Checked here rather than by a database unique constraint on
   * [organizationId, name] because revoked rows must not block a name forever:
   * revoking "production" and then re-issuing "production" later is normal, and
   * a constraint would make it impossible. The check counts only live keys.
   *
   * The alternative was left to the caller, which is how this arrived: the
   * service creates the row and nothing upstream looks.
   */
  const nameTaken = await prisma.apiKey.findFirst({
    where: { organizationId: input.organizationId, name: input.name, revokedAt: null },
    select: { id: true },
  });

  if (nameTaken) {
    // The plan check in the controller runs first, so reaching here means the
    // caller is entitled; this is the refusal, and it is a conflict rather than
    // an invalid request, because the name itself is perfectly well formed.
    throw new ApiKeyNameTakenError(input.name);
  }

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

/**
 * Removes a REVOKED key's row.
 *
 * Revoking keeps the row so the settings screen can show what was issued and
 * what has been killed, and so the duplicate-name check can tell a live key from
 * a dead one - which check already ignores revoked rows, so a key's name is
 * reusable the moment it is revoked and this deletion is never in the way.
 *
 * Refused while the key is live. A live key is a credential, and removing it
 * quietly would end an integration with no record that anybody decided to.
 *
 * The name and prefix go into the audit detail because they are the part of the
 * row that names the credential, and the row is about to stop existing.
 */
export async function deleteRevokedApiKey(
  organizationId: string,
  keyId: string,
  actorUserId?: string | null,
): Promise<'deleted' | 'not_found' | 'still_active'> {
  const existing = await prisma.apiKey.findFirst({
    where: { id: keyId, organizationId },
    select: { id: true, name: true, prefix: true, revokedAt: true },
  });

  if (!existing) {
    return 'not_found';
  }

  if (existing.revokedAt === null) {
    return 'still_active';
  }

  await prisma.apiKey.delete({ where: { id: existing.id } });

  await recordAuditEvent({
    organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'API_KEY_DELETED',
    targetType: 'api_key',
    targetId: existing.id,
    detail: { name: existing.name, prefix: existing.prefix, revokedAt: existing.revokedAt.toISOString() },
  });

  return 'deleted';
}

/** Every revoked key in the workspace, removed in one call. */
export async function deleteAllRevokedApiKeys(
  organizationId: string,
  actorUserId?: string | null,
): Promise<number> {
  const revoked = await prisma.apiKey.findMany({
    where: { organizationId, revokedAt: { not: null } },
    select: { id: true },
  });

  if (revoked.length === 0) {
    return 0;
  }

  const result = await prisma.apiKey.deleteMany({
    where: { id: { in: revoked.map((row) => row.id) } },
  });

  await recordAuditEvent({
    organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'API_KEY_DELETED',
    targetType: 'api_key',
    detail: { bulk: true, removed: result.count },
  });

  return result.count;
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
