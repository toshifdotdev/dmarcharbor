import type { Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { assertFeature } from '../services/entitlements/entitlement.service.js';
import { buildPage, parsePagination } from '../utils/pagination.js';
import { resourceIdSchema } from '../models/client.model.js';
import { dmarcRecordQuerySchema, reportShareCreateSchema } from '../models/onboarding.model.js';
import {
  assessPolicyReadiness,
  buildDmarcRecord,
  getOnboardingState,
} from '../services/onboarding.service.js';
import { domainRef } from '../services/domain-ref.js';
import {
  createReportShare,
  deleteAllRevokedReportShares,
  deleteRevokedReportShare,
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
      error: {
        code: 'INVALID_REQUEST',
        message:
          'policy must be one of none, quarantine or reject. pct must be a whole number between 0 and 100, and forensics must be true or false.',
      },
    });
    return;
  }

  response.json(buildDmarcRecord(domain, query.data.policy, query.data.forensics, query.data.pct));
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

  // A share link publishes report data to anyone holding the URL, so it is a
  // paid feature and not just a link.
  await assertFeature(response.locals.organizationId, 'sharing.links');

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

  await recordAuditEvent({
    organizationId: response.locals.organizationId,
    // The resolved id from the service, never `body.data.domainId`. The request
    // may have carried a slug, and a slug in this column is a foreign key
    // violation: the create succeeded, the audit threw, and the operator saw a
    // 500 for a share that had in fact been created.
    domainId: share.domainId,
    actorUserId: response.locals.session?.user?.id,
    action: 'REPORT_SHARE_CREATED',
    targetType: 'report_share',
    targetId: share.id,
    detail: {
      includeForensics: share.includeForensics,
      includeSources: share.includeSources,
      expiresAt: share.expiresAt.toISOString(),
    },
    requestId: response.locals.requestId,
  });

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

  await recordAuditEvent({
    organizationId: response.locals.organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'REPORT_SHARE_REVOKED',
    targetType: 'report_share',
    targetId: shareId,
    requestId: response.locals.requestId,
  });

  response.status(204).send();
}

export async function deleteReportShareController(request: Request, response: Response): Promise<void> {
  const shareId = parseId(request.params.shareId);
  if (!shareId) {
    response.status(400).json({ error: { message: 'A valid share identifier is required.' } });
    return;
  }

  const outcome = await deleteRevokedReportShare(
    response.locals.organizationId,
    shareId,
    response.locals.session?.user?.id,
  );

  if (outcome === 'not_found') {
    response.status(404).json({ error: { message: 'That share link is not in this workspace.' } });
    return;
  }

  if (outcome === 'still_active') {
    // Revoking first is the point: it is what records that the link was pulled
    // rather than quietly disappearing, which is what a client would otherwise
    // experience as the link failing with no explanation.
    response.status(409).json({
      error: {
        code: 'REPORT_SHARE_STILL_ACTIVE',
        message: 'Revoke this share link first. Removing it while it still works would kill a link somebody is holding without any record that it was pulled.',
      },
    });
    return;
  }

  response.status(204).send();
}

export async function deleteAllRevokedReportSharesController(
  _request: Request,
  response: Response,
): Promise<void> {
  const removed = await deleteAllRevokedReportShares(
    response.locals.organizationId,
    response.locals.session?.user?.id,
  );
  response.json({ removed });
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
    where: { client: { organizationId }, ...domainRef(domainId) },
    select: { name: true },
  });

  return domain?.name ?? null;
}
