import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import { apiKeyCreateSchema, bulkClientsSchema, bulkDomainsSchema } from '../models/api.model.js';
import { resourceIdSchema } from '../models/client.model.js';
import { EntitlementError, assertFeature } from '../services/entitlements/entitlement.service.js';
import {
  createApiKey,
  findIdempotentResult,
  listApiKeys,
  revokeApiKey,
  saveIdempotentResult,
} from '../services/api-key.service.js';
import { bulkImportClients, bulkImportDomains, bulkLimits, normaliseDomain } from '../services/bulk-onboarding.service.js';
import { idempotencyKeyFrom } from '../middleware/api-auth.middleware.js';
import { parsePagination } from '../utils/pagination.js';

/**
 * Trims a page from an over-fetched result, keeping the shape callers had before.
 *
 * Both list endpoints previously returned bare arrays with every row, so paging
 * them is a breaking change to the body. Keeping the array under the same key and
 * returning `nextCursor` beside it lets an existing caller carry on untouched
 * while a paging one gets what it needs - the alternative is releasing a version
 * of the public API that breaks every customer integration at once.
 */
function pageOf<T extends { id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return { items, nextCursor: hasMore && last ? last.id : null };
}


function sendError(response: Response, error: unknown): void {
  if (error instanceof EntitlementError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL', message: 'The request could not be completed.' } });
}

async function withIdempotency(
  request: Request,
  response: Response,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const key = idempotencyKeyFrom(request);
  const organizationId = response.locals.organizationId as string;

  if (!key) {
    const result = await handler();
    response.status(result.status).json(result.body);
    return;
  }

  const fingerprint = createHash('sha256')
    .update(`${organizationId}:${request.method}:${request.originalUrl}:${JSON.stringify(request.body ?? {})}`)
    .digest('hex');

  const existing = await findIdempotentResult(organizationId, key);

  if (existing) {
    /**
     * A reused key with a different payload is a conflict, not a replay.
     *
     * The hash was computed and stored but never compared, so an integration
     * that reused a key across two different bodies got the first response back
     * and silently lost the second request. Returning 409 is what the documented
     * contract promises and is the only safe answer: the caller cannot be told
     * which of the two payloads this response corresponds to.
     */
    if (existing.requestHash !== fingerprint) {
      response.status(409).json({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'That Idempotency-Key was already used with a different request body.',
        },
      });
      return;
    }

    response.setHeader('Idempotency-Replayed', 'true');
    response.status(existing.statusCode ?? 200).json(existing.responseBody ?? {});
    return;
  }

  const result = await handler();
  await saveIdempotentResult({
    key,
    organizationId,
    requestHash: fingerprint,
    statusCode: result.status,
    responseBody: result.body,
  });
  response.status(result.status).json(result.body);
}

export async function bulkClientsController(request: Request, response: Response): Promise<void> {
  const body = bulkClientsSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: body.error.issues[0]?.message ?? 'A list of clients is required.' },
    });
    return;
  }

  try {
    await withIdempotency(request, response, async () => {
      const result = await bulkImportClients({
        organizationId: response.locals.organizationId,
        actorUserId: null,
        clients: body.data.clients,
      });

      return {
        status: 201,
        body: {
          created: result.created.length,
          failed: result.failed.length,
          planBlocked: result.planBlocked.length,
          clients: result.created,
          failures: result.failed,
          planLimitRejections: result.planBlocked,
          limits: bulkLimits,
        },
      };
    });
  } catch (error) {
    sendError(response, error);
  }
}

export async function bulkDomainsController(request: Request, response: Response): Promise<void> {
  const body = bulkDomainsSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: body.error.issues[0]?.message ?? 'A client and a list of domains are required.' },
    });
    return;
  }

  try {
    await withIdempotency(request, response, async () => {
      const result = await bulkImportDomains({
        organizationId: response.locals.organizationId,
        actorUserId: null,
        clientId: body.data.clientId,
        domains: body.data.domains,
      });

      return {
        status: 201,
        body: {
          created: result.created.length,
          failed: result.failed.length,
          planBlocked: result.planBlocked.length,
          domains: result.created,
          failures: result.failed,
          planLimitRejections: result.planBlocked,
          limits: bulkLimits,
        },
      };
    });
  } catch (error) {
    sendError(response, error);
  }
}

export async function listApiClientsController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const page = parsePagination(request, response);
  if (!page.ok) {
    return;
  }

  /**
   * Bounded, because it returned every client and every domain of every client.
   *
   * `GET /api/v1/domains` is the whole reason the public API exists, and it was
   * also the endpoint a single workspace could use to make this process build a
   * list it then serialised in one go: an agency with 3 000 domains gets a body
   * in the tens of megabytes, and the process buffers all of it. Pagination is
   * not a nicety here, it is the difference between an endpoint and an out of
   * memory.
   */
  const clients = await prisma.client.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      domains: {
        select: { id: true, name: true, status: true, dmarcPolicy: true, verifiedAt: true },
        orderBy: { name: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
    // One extra row decides whether there is a next page, so the limit is not
    // silently truncated by asking for exactly `limit` and guessing.
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });

  const { items, nextCursor } = pageOf(clients, page.limit);
  response.json({ clients: items, nextCursor });
}

export async function createApiClientController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const slug = typeof request.body?.slug === 'string' ? request.body.slug.trim() : undefined;
  const rawDomains = Array.isArray(request.body?.domains) ? (request.body.domains as string[]) : [];

  if (!name) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A client name is required.' } });
    return;
  }

  const domains = rawDomains.map(normaliseDomain);
  if (domains.some((value) => value === null)) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'One of those domain names is not usable.' } });
    return;
  }

  try {
    const result = await bulkImportClients({
      organizationId,
      actorUserId: null,
      clients: [{ name, ...(slug ? { slug } : {}), domains: domains as string[] }],
    });

    if (result.created.length === 0) {
      response.status(result.planBlocked.length > 0 ? 402 : 409).json({
        error: {
          code: result.planBlocked.length > 0 ? 'PLAN_LIMIT_REACHED' : 'CONFLICT',
          message: result.planBlocked[0]?.reason ?? result.failed[0]?.reason ?? 'That client could not be created.',
        },
      });
      return;
    }

    response.status(201).json(result.created[0]);
  } catch (error) {
    sendError(response, error);
  }
}

export async function createApiDomainController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const clientId = typeof request.body?.clientId === 'string' ? request.body.clientId : '';
  const raw = typeof request.body?.name === 'string' ? request.body.name : '';
  const name = normaliseDomain(raw);

  if (!clientId || !name) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A client and a domain name are required.' } });
    return;
  }

  try {
    const result = await bulkImportDomains({ organizationId, actorUserId: null, clientId, domains: [name] });

    if (result.created.length === 0) {
      response.status(result.planBlocked.length > 0 ? 402 : 409).json({
        error: {
          code: result.planBlocked.length > 0 ? 'PLAN_LIMIT_REACHED' : 'CONFLICT',
          message: result.planBlocked[0]?.reason ?? result.failed[0]?.reason ?? 'That domain could not be added.',
        },
      });
      return;
    }

    response.status(201).json(result.created[0]);
  } catch (error) {
    sendError(response, error);
  }
}

export async function verifyApiDomainController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const domainId = resourceIdSchema.safeParse(request.params.domainId);

  if (!domainId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid domain identifier is required.' } });
    return;
  }

  const { verifyDomain } = await import('../services/client.service.js');
  const outcome = await verifyDomain(organizationId, domainId.data);

  if (!outcome) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json({
    domain: { id: outcome.domain.id, name: outcome.domain.name, status: outcome.domain.status },
    verification: outcome.verification,
  });
}

export async function listApiDomainsController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const page = parsePagination(request, response);
  if (!page.ok) {
    return;
  }

  const domains = await prisma.domain.findMany({
    where: { client: { organizationId } },
    select: {
      id: true,
      name: true,
      status: true,
      dmarcPolicy: true,
      dmarcRecord: true,
      verifiedAt: true,
      score: true,
      collectForensicReports: true,
      client: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { name: 'asc' },
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });

  const { items, nextCursor } = pageOf(domains, page.limit);
  response.json({ domains: items, nextCursor });
}

export async function createApiKeyController(request: Request, response: Response): Promise<void> {
  // Minting a key is the entry point to the whole public API, so the plan
  // check belongs here. Without it the free tier can drive bulk onboarding and
  // webhooks, which is a paid feature running on a zero rupee account.
  await assertFeature(response.locals.organizationId, 'api.access');

  const body = apiKeyCreateSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: body.error.issues[0]?.message ?? 'A key name and at least one scope are required.' },
    });
    return;
  }

  const issued = await createApiKey({
    organizationId: response.locals.organizationId,
    name: body.data.name,
    scopes: body.data.scopes,
    expiresInDays: body.data.expiresInDays,
  });

  response.status(201).json({
    ...issued,
    notice: 'This key is shown once and cannot be retrieved again. Store it now.',
  });
}

export async function listApiKeysController(_request: Request, response: Response): Promise<void> {
  const keys = await listApiKeys(response.locals.organizationId);
  response.json({ apiKeys: keys });
}

export async function revokeApiKeyController(request: Request, response: Response): Promise<void> {
  const revoked = await revokeApiKey(response.locals.organizationId, String(request.params.keyId));

  if (!revoked) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That key was not found or is already revoked.' } });
    return;
  }

  response.status(204).send();
}
