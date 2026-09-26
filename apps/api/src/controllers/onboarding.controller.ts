import type { Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import { buildPage, parsePagination } from '../utils/pagination.js';
import { resourceIdSchema } from '../models/client.model.js';
import { dmarcRecordQuerySchema, reportShareCreateSchema } from '../models/onboarding.model.js';
import {
  assessPolicyReadiness,
  buildDmarcRecord,
  getOnboardingState,
} from '../services/onboarding.service.js';
import {
  createReportShare,
  getPublicReport,
  listReportShares,
  revokeReportShare,
} from '../services/report-share.service.js';

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function onboardingStateController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const onboarding = await getOnboardingState(response.locals.organizationId, domainId);
  if (!onboarding) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json(onboarding);
}

export async function dmarcRecordController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const domain = await prismaDomainName(response.locals.organizationId, domainId);
  if (!domain) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  const query = dmarcRecordQuerySchema.safeParse(request.query);
  if (!query.success) {
    response.status(400).json({
      error: { message: 'policy must be one of none, quarantine or reject, and forensics must be true or false.' },
    });
    return;
  }

  response.json(buildDmarcRecord(domain, query.data.policy, query.data.forensics));
}

export async function policyReadinessController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const exists = await prismaDomainName(response.locals.organizationId, domainId);
  if (!exists) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json(await assessPolicyReadiness(response.locals.organizationId, domainId));
}

export async function createReportShareController(request: Request, response: Response): Promise<void> {
  const body = reportShareCreateSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { message: 'A valid domain and expiry are required.' } });
    return;
  }

  const share = await createReportShare({
    organizationId: response.locals.organizationId,
    domainId: body.data.domainId,
    createdById: response.locals.session?.user?.id,
    includeForensics: body.data.includeForensics,
    includeSources: body.data.includeSources,
    expiresInDays: body.data.expiresInDays,
  });

  if (!share) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.status(201).json(share);
}

export async function listReportSharesController(request: Request, response: Response): Promise<void> {
  const page = parsePagination(request, response);
  if (!page.ok) {
    return;
  }

  const { rows } = await listReportShares(response.locals.organizationId, {
    limit: page.limit,
    cursor: page.cursor,
  });

  response.json(buildPage(rows, page.limit));
}

export async function revokeReportShareController(request: Request, response: Response): Promise<void> {
  const shareId = parseId(request.params.shareId);
  if (!shareId) {
    response.status(400).json({ error: { message: 'A valid share identifier is required.' } });
    return;
  }

  const revoked = await revokeReportShare(response.locals.organizationId, shareId);
  if (!revoked) {
    response.status(404).json({ error: { message: 'Share link not found or already revoked.' } });
    return;
  }

  response.status(204).send();
}

export async function publicReportController(request: Request, response: Response): Promise<void> {
  const token = typeof request.params.token === 'string' ? request.params.token : '';

  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
    response.status(404).json({ error: { message: 'Report not found.' } });
    return;
  }

  const report = await getPublicReport(token);
  if (!report) {
    response.status(404).json({ error: { message: 'Report not found, revoked, or expired.' } });
    return;
  }

  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.json(report);
}

async function prismaDomainName(organizationId: string, domainId: string): Promise<string | null> {
  const domain = await prisma.domain.findFirst({
    where: { id: domainId, client: { organizationId } },
    select: { name: true },
  });

  return domain?.name ?? null;
}
