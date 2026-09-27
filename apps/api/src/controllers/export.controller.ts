import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { exportCreateSchema } from '../models/export.model.js';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { assertFeature } from '../services/entitlements/entitlement.service.js';
import { exportJobRetentionDays, exportLinkDays, buildCsvExport, buildExportPayload, createExportJob, hashToken } from '../services/export/export.service.js';

async function findTarget(organizationId: string, scope: string, targetId: string | undefined) {
  if (scope === 'CLIENT' && targetId) {
    return prisma.client.findFirst({ where: { id: targetId, organizationId }, select: { id: true } });
  }
  if (scope === 'DOMAIN' && targetId) {
    return prisma.domain.findFirst({ where: { id: targetId, client: { organizationId } }, select: { id: true } });
  }
  return null;
}

export async function createExportController(request: Request, response: Response): Promise<void> {
  const body = exportCreateSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A scope of workspace, client or domain is required, and a format of JSON or CSV.' },
    });
    return;
  }

  const organizationId = response.locals.organizationId;
  const requestedById = response.locals.session?.user?.id;

  if (!requestedById) {
    response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } });
    return;
  }

  if (body.data.scope !== 'ORGANIZATION' && !body.data.targetId) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A client or domain export needs the target identifier.' },
    });
    return;
  }

  const target = await findTarget(organizationId, body.data.scope, body.data.targetId);
  if (body.data.scope !== 'ORGANIZATION' && !target) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That target is not in this workspace.' } });
    return;
  }

  // The right to take your own data away is statutory, so this passes on every
  // plan. The assertion stays in the request path so a future pricing edit
  // cannot quietly start blocking it.
  await assertFeature(organizationId, 'data.export');

  const job = await createExportJob({
    organizationId,
    requestedById,
    scope: body.data.scope,
    targetId: body.data.targetId,
    format: body.data.format,
  });

  await recordAuditEvent({
    organizationId,
    actorUserId: requestedById,
    action: 'EXPORT_REQUESTED',
    targetType: 'export_job',
    targetId: job.id,
    detail: { scope: body.data.scope, targetId: body.data.targetId ?? null, format: body.data.format },
    requestId: response.locals.requestId,
  });

  response.status(201).json({
    id: job.id,
    scope: body.data.scope,
    format: body.data.format,
    downloadUrl: `/api/workspaces/${organizationId}/exports/${job.id}/download?token=${encodeURIComponent(job.token)}`,
    token: job.token,
    expiresAt: job.expiresAt.toISOString(),
    linkDays: exportLinkDays,
    recordRetentionDays: exportJobRetentionDays,
  });
}

export async function listExportsController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;

  const jobs = await prisma.exportJob.findMany({
    where: { organizationId },
    select: {
      id: true,
      scope: true,
      scopeLabel: true,
      format: true,
      state: true,
      createdAt: true,
      downloadExpiresAt: true,
      downloadedAt: true,
      requestedById: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  response.json({ exports: jobs, linkDays: exportLinkDays, recordRetentionDays: exportJobRetentionDays });
}

async function loadJob(organizationId: string, exportId: string, token?: string) {
  const parsed = resourceIdSchema.safeParse(exportId);
  if (!parsed.success) {
    return null;
  }

  const job = await prisma.exportJob.findFirst({
    where: { id: parsed.data, organizationId },
    select: {
      id: true,
      scope: true,
      targetId: true,
      scopeLabel: true,
      format: true,
      state: true,
      downloadTokenHash: true,
      downloadExpiresAt: true,
      purgeAfter: true,
    },
  });

  if (!job) {
    return null;
  }

  if (token !== undefined) {
    if (job.state !== 'READY' || !job.downloadTokenHash || !job.downloadExpiresAt) {
      return null;
    }
    if (job.downloadExpiresAt.getTime() <= Date.now()) {
      return null;
    }
    if (hashToken(token) !== job.downloadTokenHash) {
      return null;
    }
  }

  return job;
}

export async function getExportController(request: Request, response: Response): Promise<void> {
  const job = await loadJob(response.locals.organizationId, String(request.params.exportId));

  if (!job) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Export not found.' } });
    return;
  }

  response.json({
    id: job.id,
    scope: job.scope,
    scopeLabel: job.scopeLabel,
    format: job.format,
    state: job.state,
    downloadExpiresAt: job.downloadExpiresAt?.toISOString() ?? null,
    purgeAfter: job.purgeAfter.toISOString(),
  });
}

export async function downloadExportController(request: Request, response: Response): Promise<void> {
  const token = typeof request.query.token === 'string' ? request.query.token : undefined;

  if (!token) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A download token is required.' },
    });
    return;
  }

  const job = await loadJob(response.locals.organizationId, String(request.params.exportId), token);

  if (!job) {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'This export link is invalid, expired or revoked.' },
    });
    return;
  }

  const payload = await buildExportPayload({
    organizationId: response.locals.organizationId,
    scope: job.scope,
    targetId: job.targetId ?? undefined,
    format: job.format,
    scopeLabel: job.scopeLabel,
  });

  const filename = `dmarc-harbor-export-${job.scope.toLowerCase()}-${job.id.slice(0, 8)}.${job.format === 'CSV' ? 'csv' : 'json'}`;

  await prisma.exportJob.update({ where: { id: job.id }, data: { downloadedAt: new Date() } });
  await recordAuditEvent({
    organizationId: response.locals.organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'EXPORT_DOWNLOADED',
    targetType: 'export_job',
    targetId: job.id,
    detail: { format: job.format, scope: job.scope },
    requestId: response.locals.requestId,
  });

  response.setHeader('Content-Type', job.format === 'CSV' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  response.setHeader('Cache-Control', 'no-store');

  response.send(job.format === 'CSV' ? buildCsvExport(payload) : JSON.stringify(payload, null, 2));
}

export async function revokeExportController(request: Request, response: Response): Promise<void> {
  const job = await loadJob(response.locals.organizationId, String(request.params.exportId));

  if (!job) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Export not found.' } });
    return;
  }

  await prisma.exportJob.update({ where: { id: job.id }, data: { state: 'REVOKED', downloadTokenHash: null } });

  await recordAuditEvent({
    organizationId: response.locals.organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'EXPORT_REVOKED',
    targetType: 'export_job',
    targetId: job.id,
    requestId: response.locals.requestId,
  });

  response.status(204).send();
}
