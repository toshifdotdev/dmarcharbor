import type { Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import { resourceIdSchema } from '../models/client.model.js';
import { erasureExecuteSchema, erasureRequestSchema } from '../models/erasure.model.js';
import { assertFeature } from '../services/entitlements/entitlement.service.js';
import {
  cancelErasure,
  erasureCertificateRetentionDays,
  executeErasure,
  previewErasure,
  requestErasure,
} from '../services/erasure/erasure.service.js';

async function targetExists(organizationId: string, scope: string, targetId: string | undefined) {
  if (scope === 'CLIENT' && targetId) {
    return prisma.client.findFirst({ where: { id: targetId, organizationId }, select: { id: true } });
  }
  if (scope === 'DOMAIN' && targetId) {
    return prisma.domain.findFirst({ where: { id: targetId, client: { organizationId } }, select: { id: true } });
  }
  return null;
}

export async function previewErasureController(request: Request, response: Response): Promise<void> {
  const query = request.query;

  if (typeof query.scope !== 'string' || !['ORGANIZATION', 'CLIENT', 'DOMAIN'].includes(query.scope)) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'scope must be ORGANIZATION, CLIENT or DOMAIN.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const scope = query.scope as 'ORGANIZATION' | 'CLIENT' | 'DOMAIN';
  const targetId = typeof query.targetId === 'string' ? query.targetId : undefined;

  if (scope !== 'ORGANIZATION' && !targetId) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A client or domain preview needs the target identifier.' } });
    return;
  }

  if (scope !== 'ORGANIZATION' && !(await targetExists(organizationId, scope, targetId))) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That target is not in this workspace.' } });
    return;
  }

  response.json(await previewErasure(organizationId, scope, targetId));
}

export async function requestErasureController(request: Request, response: Response): Promise<void> {
  const body = erasureRequestSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A scope of workspace, client or domain is required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const requestedById = response.locals.session?.user?.id;

  if (!requestedById) {
    response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } });
    return;
  }

  if (body.data.scope !== 'ORGANIZATION' && !body.data.targetId) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A client or domain erasure needs the target identifier.' } });
    return;
  }

  if (body.data.scope !== 'ORGANIZATION' && !(await targetExists(organizationId, body.data.scope, body.data.targetId))) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That target is not in this workspace.' } });
    return;
  }

  // Erasure is a statutory right and is never paywalled.
  await assertFeature(organizationId, 'data.erase');

  const outcome = await requestErasure({
    organizationId,
    requestedById,
    scope: body.data.scope,
    targetId: body.data.targetId,
    reason: body.data.reason,
  });

  response.status(202).json({
    id: outcome.id,
    state: 'PENDING',
    purgeAfter: outcome.purgeAfter.toISOString(),
    preview: outcome.preview,
  });
}

export async function listErasuresController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;

  const requests = await prisma.erasureRequest.findMany({
    where: { organizationId },
    select: {
      id: true,
      scope: true,
      targetId: true,
      state: true,
      requestedById: true,
      createdAt: true,
      purgeAfter: true,
      completedAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  response.json({ requests, certificateRetentionDays: erasureCertificateRetentionDays });
}

async function loadRequest(organizationId: string, erasureId: string) {
  const parsed = resourceIdSchema.safeParse(erasureId);
  if (!parsed.success) {
    return null;
  }
  return prisma.erasureRequest.findFirst({ where: { id: parsed.data, organizationId } });
}

export async function getErasureController(request: Request, response: Response): Promise<void> {
  const record = await loadRequest(response.locals.organizationId, String(request.params.erasureId));

  if (!record) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Erasure request not found.' } });
    return;
  }

  response.json({
    id: record.id,
    scope: record.scope,
    targetId: record.targetId,
    state: record.state,
    requestedById: record.requestedById,
    createdAt: record.createdAt.toISOString(),
    purgeAfter: record.purgeAfter.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    certificate: record.certificate ?? null,
  });
}

export async function cancelErasureController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const cancelled = await cancelErasure(organizationId, String(request.params.erasureId), response.locals.session?.user?.id ?? '');

  if (!cancelled) {
    response.status(409).json({ error: { code: 'CONFLICT', message: 'That request is no longer pending.' } });
    return;
  }

  response.status(204).send();
}

export async function executeErasureController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const record = await loadRequest(organizationId, String(request.params.erasureId));

  if (!record) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Erasure request not found.' } });
    return;
  }

  if (record.state !== 'PENDING') {
    response.status(409).json({ error: { code: 'CONFLICT', message: `That request is already ${record.state.toLowerCase()}.` } });
    return;
  }

  const graceOver = record.purgeAfter.getTime() <= Date.now();
  const body = graceOver ? { success: true } : erasureExecuteSchema.safeParse(request.body);

  if (!graceOver && !body.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'This request is still inside its grace period. Set confirmNamePurge to true to run it early, or wait.',
      },
    });
    return;
  }

  const outcome = await executeErasure(record.id);

  if (!outcome) {
    response.status(409).json({ error: { code: 'CONFLICT', message: 'That request could not be executed.' } });
    return;
  }

  // The service records ERASURE_COMPLETED before the deletes, so the entry
  // survives via the audit trail's SetNull organisation. Writing it again here
  // would fail the foreign key once the workspace no longer exists.
  response.json(outcome);
}
