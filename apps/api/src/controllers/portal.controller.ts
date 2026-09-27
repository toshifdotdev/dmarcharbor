import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import { assertFeature } from '../services/entitlements/entitlement.service.js';
import { grantPortalAccess, listPortalAccess, revokePortalAccess } from '../services/portal.service.js';
import { getDomainInsights } from '../services/report-intelligence.service.js';
import { buildSenderBreakdown, possibleSpoofingSources } from '../services/sender-breakdown.service.js';
import { portalClientFilter } from '../middleware/portal.middleware.js';
import { resourceIdSchema } from '../models/client.model.js';

const grantSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().max(120).optional(),
});

export async function grantPortalAccessController(request: Request, response: Response): Promise<void> {
  const clientId = resourceIdSchema.safeParse(request.params.clientId);
  if (!clientId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid client identifier is required.' } });
    return;
  }

  const body = grantSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid email address is required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  await assertFeature(organizationId, 'portal.client');

  const grant = await grantPortalAccess({
    organizationId,
    clientId: clientId.data,
    email: body.data.email,
    displayName: body.data.displayName ?? null,
    invitedById: response.locals.session?.user?.id,
  });

  if (!grant) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found in this workspace.' } });
    return;
  }

  response.status(201).json({
    ...grant,
    notice:
      'The grant is held against this email address. It activates the first time that person signs in with the same address, and covers that client only.',
  });
}

export async function listPortalAccessController(request: Request, response: Response): Promise<void> {
  const clientId = typeof request.query.clientId === 'string' ? request.query.clientId : undefined;
  response.json({ grants: await listPortalAccess(response.locals.organizationId, clientId) });
}

export async function revokePortalAccessController(request: Request, response: Response): Promise<void> {
  const id = resourceIdSchema.safeParse(request.params.accessId);
  if (!id.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid access identifier is required.' } });
    return;
  }

  const revoked = await revokePortalAccess(
    response.locals.organizationId,
    id.data,
    response.locals.session?.user?.id,
  );

  if (!revoked) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That access grant was not found or is already revoked.' } });
    return;
  }

  response.status(204).send();
}

export async function portalOverviewController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const clientFilter = portalClientFilter(response);

  const clients = await prisma.client.findMany({
    where: { ...clientFilter, organizationId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      domains: {
        where: { status: 'VERIFIED' },
        select: {
          id: true,
          name: true,
          status: true,
          score: true,
          dmarcPolicy: true,
          verifiedAt: true,
          lastScanAt: true,
        },
        orderBy: { name: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });

  const domainIds = clients.flatMap((client) => client.domains.map((domain) => domain.id));
  const reportCount = await prisma.dmarcReport.count({ where: { domainId: { in: domainIds } } });
  const lastReport = await prisma.dmarcReport.findFirst({
    where: { domainId: { in: domainIds } },
    select: { receivedAt: true },
    orderBy: { receivedAt: 'desc' },
  });

  response.json({
    workspace: { name: (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } })).name },
    grants: response.locals.portalGrants,
    clients,
    totals: {
      clients: clients.length,
      domains: clients.reduce((total, client) => total + client.domains.length, 0),
      reports: reportCount,
    },
    lastReportAt: lastReport?.receivedAt?.toISOString() ?? null,
  });
}

export async function portalDomainController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  if (!domainId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid domain identifier is required.' } });
    return;
  }

  const domain = await prisma.domain.findFirst({
    where: { id: domainId.data, client: { ...portalClientFilter(response), organizationId } },
    select: {
      id: true,
      name: true,
      status: true,
      score: true,
      dmarcPolicy: true,
      dmarcRecord: true,
      verifiedAt: true,
      lastScanAt: true,
      client: { select: { id: true, name: true } },
    },
  });

  if (!domain) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That domain is not available to this account.' } });
    return;
  }

  const insights = await getDomainInsights(organizationId, domain.id);
  const senders = await buildSenderBreakdown(organizationId, domain.id);

  response.json({
    domain,
    aggregate: insights?.aggregate ?? null,
    senders,
    possibleSpoofingSources: possibleSpoofingSources(senders),
  });
}
