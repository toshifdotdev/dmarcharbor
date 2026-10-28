import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import {
  apiClientCreateSchema,
  apiDomainCreateSchema,
  apiKeyCreateSchema,
  bulkClientsSchema,
  bulkDomainsSchema,
} from '../models/api.model.js';
import { resourceIdSchema } from '../models/client.model.js';
import { EntitlementError, assertFeature } from '../services/entitlements/entitlement.service.js';
import {
  ApiKeyNameTakenError,
  createApiKey,
  deleteAllRevokedApiKeys,
  deleteRevokedApiKey,
  findIdempotentResult,
  listApiKeys,
  revokeApiKey,
  saveIdempotentResult,
  type IssuedApiKey,
} from '../services/api-key.service.js';
import { bulkImportClients, bulkImportDomains, bulkLimits, normaliseDomain } from '../services/bulk-onboarding.service.js';
import { idempotencyKeyFrom } from '../middleware/api-auth.middleware.js';
import { zodMessage } from '../utils/zod-messages.js';
import { parsePagination } from '../utils/pagination.js';
import { domainRef } from '../services/domain-ref.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { resolveEntitlements } from '../services/entitlements/entitlement.service.js';
import { listDomainScans, runDomainScan } from '../services/domain-scan.service.js';
import { listDomainReports } from '../services/report.service.js';
import { buildSenderBreakdown } from '../services/sender-breakdown.service.js';
import { assessPolicyReadiness } from '../services/onboarding.service.js';
import { getTlsReportSummary } from '../services/tls-report/tls-report-query.service.js';
import { acknowledgeAlertEvent, listAlertEvents } from '../services/alert.service.js';
import { acknowledgeDnsChange, listDnsChanges } from '../services/monitoring/dns-change.service.js';
import {
  serializeAlert,
  serializeDnsChange,
  serializeDomainDetail,
  serializeMe,
  serializeReport,
  serializeScan,
  serializeSender,
  serializeTlsSummary,
} from '../services/api-v1/serializers.js';

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
  /**
   * A refusal is not a result.
   *
   * Only a success is stored. Saving a 402 or a 409 would make the key replay the
   * refusal for 24 hours — so a caller who fixed their plan or their name and
   * retried with the same key would keep getting the old answer, which is worse
   * than having no idempotency at all. A failed request is safe to repeat: it
   * changed nothing.
   */
  if (result.status < 400) {
    await saveIdempotentResult({
      key,
      organizationId,
      requestHash: fingerprint,
      statusCode: result.status,
      responseBody: result.body,
    });
  }
  response.status(result.status).json(result.body);
}

export async function bulkClientsController(request: Request, response: Response): Promise<void> {
  const body = bulkClientsSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: zodMessage(body.error.issues) ?? 'A list of clients is required.' },
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
      error: { code: 'INVALID_REQUEST', message: zodMessage(body.error.issues) ?? 'A client and a list of domains are required.' },
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

  // The schemas that already described this body were never imported, so the
  // controller read the raw body and re-implemented the checks loosely: no cap on
  // the name, no pattern on the slug, and `domains` taken as `as string[]`, which
  // let a non-string through to normaliseDomain and out as a 500 instead of a 400.
  const parsed = apiClientCreateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A client name is required.' },
    });
    return;
  }

  const { name, slug, domains: rawDomains } = parsed.data;

  const domains = rawDomains.map(normaliseDomain);
  if (domains.some((value) => value === null)) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'One of those domain names is not usable.' } });
    return;
  }

  try {
    await withIdempotency(request, response, async () => {
      const result = await bulkImportClients({
        organizationId,
        actorUserId: null,
        clients: [{ name, ...(slug ? { slug } : {}), domains: domains as string[] }],
      });

      if (result.created.length === 0) {
        return {
          status: result.planBlocked.length > 0 ? 402 : 409,
          body: {
            error: {
              code: result.planBlocked.length > 0 ? 'PLAN_LIMIT_REACHED' : 'CONFLICT',
              message: result.planBlocked[0]?.reason ?? result.failed[0]?.reason ?? 'That client could not be created.',
            },
          },
        };
      }

      return { status: 201, body: result.created[0] };
    });
  } catch (error) {
    sendError(response, error);
  }
}

export async function createApiDomainController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;

  const parsed = apiDomainCreateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A client and a domain name are required.' } });
    return;
  }

  const { clientId, name: raw } = parsed.data;
  const name = normaliseDomain(raw);

  if (!name) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A client and a domain name are required.' } });
    return;
  }

  try {
    await withIdempotency(request, response, async () => {
      const result = await bulkImportDomains({ organizationId, actorUserId: null, clientId, domains: [name] });

      if (result.created.length === 0) {
        return {
          status: result.planBlocked.length > 0 ? 402 : 409,
          body: {
            error: {
              code: result.planBlocked.length > 0 ? 'PLAN_LIMIT_REACHED' : 'CONFLICT',
              message: result.planBlocked[0]?.reason ?? result.failed[0]?.reason ?? 'That domain could not be added.',
            },
          },
        };
      }

      return { status: 201, body: result.created[0] };
    });
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

  try {
    /**
     * A key on verify replays the answer that was already given.
     *
     * That is what the header promises, and it is what makes a retry after a
     * timeout safe: the caller gets the same verdict rather than a second,
     * possibly different one that arrives while the TXT record is still
     * propagating. A caller who wants a fresh read simply omits the key.
     */
    await withIdempotency(request, response, async () => {
      const { verifyDomain } = await import('../services/client.service.js');
      const outcome = await verifyDomain(organizationId, domainId.data);

      if (!outcome) {
        return {
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: 'Domain not found in this workspace.' } },
        };
      }

      return {
        status: 200,
        body: {
          domain: { id: outcome.domain.id, name: outcome.domain.name, status: outcome.domain.status },
          verification: outcome.verification,
        },
      };
    });
  } catch (error) {
    sendError(response, error);
  }
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
      error: { code: 'INVALID_REQUEST', message: zodMessage(body.error.issues) ?? 'A key name and at least one scope are required.' },
    });
    return;
  }

  /**
   * A refused name is a conflict, and it is caught here rather than in the
   * router's error path so the response carries the same envelope as every other
   * refusal on this route. The service throws it because a caller that did not
   * check would silently create a second key with a name the operator cannot
   * tell two rows apart by.
   */
  let issued: IssuedApiKey;
  try {
    issued = await createApiKey({
      organizationId: response.locals.organizationId,
      name: body.data.name,
      scopes: body.data.scopes,
      expiresInDays: body.data.expiresInDays,
    });
  } catch (error) {
    if (error instanceof ApiKeyNameTakenError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }

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

export async function deleteApiKeyController(request: Request, response: Response): Promise<void> {
  const outcome = await deleteRevokedApiKey(
    response.locals.organizationId,
    String(request.params.keyId),
    response.locals.session?.user?.id,
  );

  if (outcome === 'not_found') {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That key is not in this workspace.' } });
    return;
  }

  if (outcome === 'still_active') {
    // Revoking first is what records that a credential was deliberately killed.
    // Removing a live key would end somebody's integration with no trace of the
    // decision behind it.
    response.status(409).json({
      error: {
        code: 'API_KEY_STILL_ACTIVE',
        message: 'Revoke this key first. Removing it while it still works would end the integration using it with no record that anybody decided to.',
      },
    });
    return;
  }

  response.status(204).send();
}

export async function deleteAllRevokedApiKeysController(_request: Request, response: Response): Promise<void> {
  const removed = await deleteAllRevokedApiKeys(
    response.locals.organizationId,
    response.locals.session?.user?.id,
  );
  response.json({ removed });
}

// ─── The wider v1 surface (Item 16) ──────────────────────────────────────────
//
// Everything below is additive: no existing path, field, status code or shape
// changes. Each route resolves its resource **within the key's workspace**, so
// "not yours" and "does not exist" are the same 404 — a caller cannot use the
// difference to enumerate another tenant's domains, alerts or changes.

/**
 * Resolves a domain by id or slug inside the key's workspace.
 *
 * `domainRef` is the same helper the browser routes use, which is what keeps the
 * two from disagreeing about whether a slug is a valid identifier.
 */
async function resolveApiDomain(organizationId: string, reference: string) {
  return prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(reference) },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      dmarcPolicy: true,
      dmarcRecord: true,
      verifiedAt: true,
      score: true,
      collectForensicReports: true,
      lastScanAt: true,
      spfRecord: true,
      mxRecords: true,
      dkimSelectors: true,
      client: { select: { id: true, name: true, slug: true } },
    },
  });
}

function notFound(response: Response, what: string): void {
  response.status(404).json({
    error: { code: 'NOT_FOUND', message: `That ${what} is not in this workspace.` },
  });
}

function invalid(response: Response, message: string): void {
  response.status(400).json({ error: { code: 'INVALID_REQUEST', message } });
}

/**
 * GET /v1/me
 *
 * The one route an integration should call first: it says which workspace the
 * key belongs to, what the plan carries, and what the key itself may do. Without
 * it every caller hard-codes the plan tiers, and a plan change becomes their
 * outage.
 */
export async function apiMeController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId as string;
  const keyId = response.locals.apiKeyId as string;

  try {
    const [organization, entitlements, key] = await Promise.all([
      prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { id: true, name: true, slug: true },
      }),
      resolveEntitlements(organizationId),
      prisma.apiKey.findUniqueOrThrow({
        where: { id: keyId },
        select: { id: true, name: true, scopes: true, expiresAt: true },
      }),
    ]);

    response.json(
      serializeMe({
        organization,
        entitlements,
        key: { id: key.id, name: key.name, scopes: key.scopes, expiresAt: key.expiresAt },
      }),
    );
  } catch (error) {
    sendError(response, error);
  }
}

export async function apiGetDomainController(request: Request, response: Response): Promise<void> {
  const domain = await resolveApiDomain(
    response.locals.organizationId,
    String(request.params.domain ?? ''),
  );

  if (!domain) {
    notFound(response, 'domain');
    return;
  }

  response.json({ domain: serializeDomainDetail(domain) });
}

export async function apiListDomainScansController(request: Request, response: Response): Promise<void> {
  const page = parsePagination(request, response);
  if (!page.ok) return;

  const domain = await resolveApiDomain(
    response.locals.organizationId,
    String(request.params.domain ?? ''),
  );
  if (!domain) {
    notFound(response, 'domain');
    return;
  }

  const { rows, nextCursor } = await listDomainScans(response.locals.organizationId, domain.id, {
    limit: page.limit,
    cursor: page.cursor,
  });

  response.json({ scans: rows.map(serializeScan), nextCursor });
}

/**
 * POST /v1/domains/{domain}/scans
 *
 * 202, because the scan is work the server does on the caller's behalf and the
 * row is the receipt. The id is returned either way: a scan that failed still
 * exists, and its `status` and `error` are how a caller finds out why.
 */
export async function apiCreateDomainScanController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;

  try {
    await withIdempotency(request, response, async () => {
      const domain = await resolveApiDomain(organizationId, String(request.params.domain ?? ''));
      if (!domain) {
        return {
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: 'That domain is not in this workspace.' } },
        };
      }

      const outcome = await runDomainScan({
        organizationId,
        domainId: domain.id,
        // No user: the key is the actor, and inventing a member would put a name
        // in the scan history that did not ask for the scan.
        requestedById: null,
      });

      if (outcome.status === 'not_found') {
        return {
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: 'That domain is not in this workspace.' } },
        };
      }

      if (outcome.status === 'not_verified') {
        return {
          status: 409,
          body: {
            error: {
              code: 'CONFLICT',
              message: 'Verify the domain before running an authenticated scan.',
            },
          },
        };
      }

      return {
        status: 202,
        body: {
          scan: serializeScan({
            id: outcome.scan.id,
            status: outcome.scan.status,
            trigger: outcome.scan.trigger,
            score: outcome.scan.score,
            error: outcome.scan.error,
            startedAt: outcome.scan.startedAt,
            completedAt: outcome.scan.completedAt,
          }),
        },
      };
    });
  } catch (error) {
    sendError(response, error);
  }
}

export async function apiListDomainReportsController(request: Request, response: Response): Promise<void> {
  const page = parsePagination(request, response);
  if (!page.ok) return;

  const domain = await resolveApiDomain(
    response.locals.organizationId,
    String(request.params.domain ?? ''),
  );
  if (!domain) {
    notFound(response, 'domain');
    return;
  }

  const { rows, limit } = await listDomainReports(response.locals.organizationId, domain.id, {
    limit: page.limit,
    cursor: page.cursor,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  response.json({ reports: items.map(serializeReport), nextCursor: hasMore && last ? last.id : null });
}

export async function apiListDomainSendersController(request: Request, response: Response): Promise<void> {
  const domain = await resolveApiDomain(
    response.locals.organizationId,
    String(request.params.domain ?? ''),
  );
  if (!domain) {
    notFound(response, 'domain');
    return;
  }

  const rows = await buildSenderBreakdown(response.locals.organizationId, domain.id);

  /**
   * Not paged, and that is not an oversight.
   *
   * `buildSenderBreakdown` already bounds its own work — the 25 senders it
   * considers and the 50,000 records it reads are the limit — so the response has
   * a ceiling of 25 rows that does not grow with the customer's traffic. Adding a
   * cursor here would suggest a page size the service does not have.
   */
  response.json({ senders: rows.map(serializeSender) });
}

export async function apiPolicyReadinessController(request: Request, response: Response): Promise<void> {
  const domain = await resolveApiDomain(
    response.locals.organizationId,
    String(request.params.domain ?? ''),
  );
  if (!domain) {
    notFound(response, 'domain');
    return;
  }

  try {
    response.json(await assessPolicyReadiness(response.locals.organizationId, domain.id));
  } catch (error) {
    sendError(response, error);
  }
}

export async function apiTlsSummaryController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;

  try {
    await assertFeature(organizationId, 'reports.tlsrpt');

    const domain = await resolveApiDomain(organizationId, String(request.params.domain ?? ''));
    if (!domain) {
      notFound(response, 'domain');
      return;
    }

    const rawDays = Number(request.query.days ?? 30);
    // Same window and same bounds as the browser summary, so two readers of the
    // same domain cannot be told different failure shares.
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.trunc(rawDays), 1), 365) : 30;

    const summary = await getTlsReportSummary(organizationId, domain.id, days);
    if (!summary) {
      notFound(response, 'domain');
      return;
    }

    response.json(serializeTlsSummary(summary));
  } catch (error) {
    sendError(response, error);
  }
}

export async function apiListAlertsController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const page = parsePagination(request, response);
  if (!page.ok) return;

  try {
    await assertFeature(organizationId, 'alerts.email');

    const stateParam = request.query.state;
    const state =
      stateParam === 'open' || stateParam === 'acknowledged' || stateParam === 'resolved'
        ? stateParam
        : undefined;

    if (stateParam !== undefined && state === undefined) {
      invalid(response, 'state must be open, acknowledged or resolved.');
      return;
    }

    const domainParam = typeof request.query.domain === 'string' ? request.query.domain : undefined;
    // The same answer as `GET /dns-changes?domain=`: a domain that is not in
    // this workspace is a 404, not an empty or unfiltered list.
    const domain = domainParam ? await resolveApiDomain(organizationId, domainParam) : null;
    if (domainParam && !domain) {
      notFound(response, 'domain');
      return;
    }

    const { rows, limit } = await listAlertEvents(organizationId, {
      domainId: domain?.id,
      limit: page.limit,
      cursor: page.cursor,
      state,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    response.json({
      alerts: items.map((row) =>
        serializeAlert({
          id: row.id,
          ruleId: row.ruleId,
          metric: row.metric,
          operator: row.operator,
          observedValue: row.observedValue,
          threshold: row.threshold,
          windowMinutes: row.windowMinutes,
          summary: row.summary,
          reminderLevel: row.reminderLevel,
          triggeredAt: row.triggeredAt,
          acknowledgedAt: row.acknowledgedAt,
          resolvedAt: row.resolvedAt,
          domain: row.domain,
          rule: row.rule,
        }),
      ),
      nextCursor: hasMore && last ? last.id : null,
    });
  } catch (error) {
    sendError(response, error);
  }
}

export async function apiAcknowledgeAlertController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const apiKeyId = response.locals.apiKeyId as string;

  try {
    await assertFeature(organizationId, 'alerts.email');

    const alertId = String(request.params.alertId ?? '');
    if (!alertId) {
      invalid(response, 'A valid alert identifier is required.');
      return;
    }

    const outcome = await acknowledgeAlertEvent(organizationId, alertId, undefined, { apiKeyId });

    if (outcome === 'not_found') {
      notFound(response, 'alert');
      return;
    }

    if (outcome === 'already_handled') {
      response.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'That alert has already been acknowledged or resolved.',
        },
      });
      return;
    }

    /**
     * The audit row is written here rather than in the service, exactly as the
     * browser controller does it, so both paths record the same action. The key
     * is the actor when there is no person: a key can be revoked, "nobody"
     * cannot.
     */
    await recordAuditEvent({
      organizationId,
      action: 'ALERT_ACKNOWLEDGED',
      targetType: 'alert_event',
      targetId: alertId,
      detail: { apiKeyId },
    });

    // Re-read the row for the response body, so the acknowledge response and the
    // list are built by the same serializer and cannot drift apart.
    const event = await prisma.alertEvent.findFirst({
      where: { id: alertId, organizationId },
      include: {
        domain: { select: { id: true, name: true, slug: true } },
        rule: { select: { id: true, name: true } },
      },
    });

    if (!event) {
      notFound(response, 'alert');
      return;
    }

    response.json({
      alert: serializeAlert({
        id: event.id,
        ruleId: event.ruleId,
        metric: event.metric,
        operator: event.operator,
        observedValue: event.observedValue,
        threshold: event.threshold,
        windowMinutes: event.windowMinutes,
        summary: event.summary,
        reminderLevel: event.reminderLevel,
        triggeredAt: event.triggeredAt,
        acknowledgedAt: event.acknowledgedAt,
        resolvedAt: event.resolvedAt,
        domain: event.domain,
        rule: event.rule,
      }),
    });
  } catch (error) {
    sendError(response, error);
  }
}

export async function apiListDnsChangesController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const page = parsePagination(request, response);
  if (!page.ok) return;

  const domainParam = typeof request.query.domain === 'string' ? request.query.domain : null;

  const severityParam = request.query.severity;
  const severities =
    typeof severityParam === 'string'
      ? severityParam
          .split(',')
          .map((value) => value.trim().toUpperCase())
          .filter((value): value is 'INFO' | 'WARNING' | 'CRITICAL' =>
            value === 'INFO' || value === 'WARNING' || value === 'CRITICAL',
          )
      : undefined;

  if (severityParam !== undefined && (severities === undefined || severities.length === 0)) {
    invalid(response, 'severity must be one of INFO, WARNING or CRITICAL.');
    return;
  }

  const acknowledgedParam = request.query.acknowledged;
  const acknowledged =
    acknowledgedParam === 'true' ? true : acknowledgedParam === 'false' ? false : undefined;

  if (acknowledgedParam !== undefined && acknowledged === undefined) {
    invalid(response, 'acknowledged must be true or false.');
    return;
  }

  const result = await listDnsChanges(organizationId, domainParam, {
    limit: page.limit,
    cursor: page.cursor,
    severity: severities,
    acknowledged,
  });

  if (!result) {
    notFound(response, 'domain');
    return;
  }

  response.json({ changes: result.rows.map(serializeDnsChange), nextCursor: result.nextCursor });
}

export async function apiAcknowledgeDnsChangeController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const apiKeyId = response.locals.apiKeyId as string;
  const changeId = String(request.params.changeId ?? '');

  if (!changeId) {
    invalid(response, 'A valid DNS change identifier is required.');
    return;
  }

  const updated = await acknowledgeDnsChange({
    organizationId,
    changeId,
    // No user id: the key is the actor. The service records `detail.apiKeyId`
    // and tells the PSA ticket that the acknowledgement came through the API.
    actorUserId: null,
    actor: { apiKeyId },
  });

  if (!updated) {
    notFound(response, 'DNS change');
    return;
  }

  response.json({ change: serializeDnsChange(updated) });
}
