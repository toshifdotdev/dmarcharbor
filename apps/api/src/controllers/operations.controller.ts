import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import { createWorkspaceSchema } from '../models/auth.model.js';
import { createClientSchema, resourceIdSchema } from '../models/client.model.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { moveDomain, previewDomainMove } from '../services/domain-move.service.js';
import {
  acknowledgeAlertsInBulk,
  bulkLimit,
  clientBookCsv,
  clientBookFilename,
  renameClient,
  renameWorkspace,
  revokeReportSharesInBulk,
} from '../services/operations.service.js';

/**
 * operations.controller.ts — the session routes for the basic operations an MSP
 * runs all day: rename a client, move a domain to another client, export the
 * client book, rename the workspace, and act on many alerts or share links at
 * once. Every route is scoped to the workspace in the path, and a resource from
 * another workspace answers 404, the same as one that does not exist.
 */

const renameClientSchema = z
  .object({
    name: createClientSchema.shape.name.optional(),
    slug: createClientSchema.shape.slug.optional(),
  })
  .refine((value) => value.name !== undefined || value.slug !== undefined, {
    message: 'Send a new name, a new slug, or both.',
  });

const moveDomainSchema = z.object({ clientId: resourceIdSchema.max(64) });

const renameWorkspaceSchema = z.object({ name: createWorkspaceSchema.shape.name });

const bulkIds = z.array(resourceIdSchema.max(64)).min(1).max(bulkLimit);
const ackSchema = z.object({ eventIds: bulkIds });
const revokeSchema = z.object({ shareIds: bulkIds });

function invalid(response: Response, message: string): void {
  response.status(400).json({ error: { code: 'INVALID_REQUEST', message } });
}

// ─── clients ─────────────────────────────────────────────────────────────────

/** POST /workspaces/:organizationId/clients/:clientId/rename */
export async function renameClientController(request: Request, response: Response): Promise<void> {
  const clientId = resourceIdSchema.safeParse(request.params.clientId);
  const body = renameClientSchema.safeParse(request.body);
  if (!clientId.success || !body.success) {
    invalid(
      response,
      'Send a name of 2 to 100 characters, a slug of 2 to 60 lowercase letters, digits and single hyphens, or both.',
    );
    return;
  }

  const outcome = await renameClient({
    organizationId: response.locals.organizationId,
    clientId: clientId.data,
    name: body.data.name,
    slug: body.data.slug,
    actorUserId: response.locals.session?.user?.id,
    requestId: response.locals.requestId,
  });

  if (!outcome.ok) {
    if (outcome.reason === 'slug_taken') {
      response.status(409).json({ error: { code: 'CONFLICT', message: 'That client slug is already in this workspace.' } });
      return;
    }
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That client is not in this workspace.' } });
    return;
  }

  response.json({ client: outcome.client, changed: outcome.changed });
}

/** GET /workspaces/:organizationId/clients/export — the client book as CSV. */
export async function clientBookExportController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId as string;
  const [book, workspace] = await Promise.all([
    clientBookCsv(organizationId),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { slug: true } }),
  ]);

  // The same action the usage export records: a file of client data left the
  // product, and the trail says who took it.
  await recordAuditEvent({
    organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'EXPORT_DOWNLOADED',
    targetType: 'client_book',
    detail: { kind: 'client_book', format: 'csv', clients: book.clients, domains: book.domains },
    requestId: response.locals.requestId,
  });

  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${clientBookFilename(workspace.slug)}"`);
  response.send(book.csv);
}

// ─── domains ─────────────────────────────────────────────────────────────────

const moveNotFound = {
  domain_not_found: 'That domain is not in this workspace.',
  client_not_found: 'That client is not in this workspace.',
} as const;

/** GET /workspaces/:organizationId/domains/:domainId/move-preview?clientId= */
export async function domainMovePreviewController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  const clientId = moveDomainSchema.shape.clientId.safeParse(request.query.clientId);
  if (!domainId.success || !clientId.success) {
    invalid(response, 'Name the client to move the domain to, as ?clientId=.');
    return;
  }

  const outcome = await previewDomainMove(response.locals.organizationId, domainId.data, clientId.data);
  if (!outcome.ok) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: moveNotFound[outcome.reason] } });
    return;
  }
  response.json(outcome.preview);
}

/** POST /workspaces/:organizationId/domains/:domainId/move */
export async function moveDomainController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  const body = moveDomainSchema.safeParse(request.body);
  if (!domainId.success || !body.success) {
    invalid(response, 'Name the client to move the domain to, as clientId.');
    return;
  }

  const outcome = await moveDomain({
    organizationId: response.locals.organizationId,
    domainId: domainId.data,
    toClientId: body.data.clientId,
    actorUserId: response.locals.session?.user?.id,
    requestId: response.locals.requestId,
  });

  if (!outcome.ok) {
    if (outcome.reason === 'blocked') {
      response.status(409).json({
        error: { code: 'CONFLICT', message: outcome.blockers.map((b) => b.message).join(' '), blockers: outcome.blockers },
      });
      return;
    }
    if (outcome.reason === 'changed') {
      response.status(409).json({
        error: { code: 'CONFLICT', message: 'The domain changed client while this was being sent. Reload and try again.' },
      });
      return;
    }
    response.status(404).json({ error: { code: 'NOT_FOUND', message: moveNotFound[outcome.reason] } });
    return;
  }

  response.json(outcome.result);
}

// ─── workspace ───────────────────────────────────────────────────────────────

/** POST /workspaces/:organizationId/rename */
export async function renameWorkspaceController(request: Request, response: Response): Promise<void> {
  const body = renameWorkspaceSchema.safeParse(request.body);
  if (!body.success) {
    invalid(response, 'Enter a workspace name of 2 to 80 characters.');
    return;
  }

  const outcome = await renameWorkspace({
    organizationId: response.locals.organizationId,
    name: body.data.name,
    actorUserId: response.locals.session?.user?.id,
    requestId: response.locals.requestId,
  });
  if (!outcome.ok) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That workspace does not exist.' } });
    return;
  }
  response.json({ workspace: outcome.workspace, changed: outcome.changed });
}

// ─── bulk ────────────────────────────────────────────────────────────────────

/**
 * POST /workspaces/:organizationId/alerts/acknowledge
 *
 * Answers per alert. When none of the ids is in this workspace the answer is a
 * 404, the same as the single route gives for an alert that is not here.
 */
export async function bulkAcknowledgeAlertsController(request: Request, response: Response): Promise<void> {
  const body = ackSchema.safeParse(request.body);
  if (!body.success) {
    invalid(response, `Send eventIds: a list of 1 to ${bulkLimit} alert identifiers.`);
    return;
  }

  const outcome = await acknowledgeAlertsInBulk({
    organizationId: response.locals.organizationId,
    eventIds: body.data.eventIds,
    actorUserId: response.locals.session?.user?.id,
    requestId: response.locals.requestId,
  });

  if (outcome.done.length === 0 && outcome.skipped.every((skip) => skip.reason === 'not_found')) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'None of those alerts is in this workspace.' } });
    return;
  }

  response.json({ acknowledged: outcome.done.length, acknowledgedIds: outcome.done, skipped: outcome.skipped });
}

/** POST /workspaces/:organizationId/report-shares/revoke */
export async function bulkRevokeReportSharesController(request: Request, response: Response): Promise<void> {
  const body = revokeSchema.safeParse(request.body);
  if (!body.success) {
    invalid(response, `Send shareIds: a list of 1 to ${bulkLimit} share link identifiers.`);
    return;
  }

  const outcome = await revokeReportSharesInBulk({
    organizationId: response.locals.organizationId,
    shareIds: body.data.shareIds,
    actorUserId: response.locals.session?.user?.id,
    requestId: response.locals.requestId,
  });

  if (outcome.done.length === 0 && outcome.skipped.every((skip) => skip.reason === 'not_found')) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'None of those share links is in this workspace.' } });
    return;
  }

  response.json({ revoked: outcome.done.length, revokedIds: outcome.done, skipped: outcome.skipped });
}
