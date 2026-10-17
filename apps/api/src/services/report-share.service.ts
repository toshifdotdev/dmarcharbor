import { randomBytes } from 'node:crypto';
import { prisma } from '../database/prisma.js';
import { hasAggregateReporting, readDmarcRecord } from '../scanner/dmarc-tags.js';
import { getDomainInsights } from './report-intelligence.service.js';
import { resolveLimit } from '../utils/pagination.js';
import { domainRef } from './domain-ref.js';
import { assessPolicyReadiness } from './onboarding.service.js';
import { recordAuditEvent } from './audit.service.js';

const defaultShareDays = 30;
const maximumShareDays = 365;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export interface CreatedShare {
  id: string;
  token: string;
  url: string;
  expiresAt: Date;
  includeForensics: boolean;
  includeSources: boolean;
  /**
   * The RESOLVED domain id, which is not always what the caller sent.
   *
   * `createReportShare` accepts an id or a slug, and a slug is what a page built
   * from the URL actually holds. Callers must audit against this rather than
   * against their own input: an audit row whose `domainId` holds a slug violates
   * the `audit_log_domainId_fkey` foreign key, which surfaced to the operator as a
   * bare 500 on "Create share link" - after the share itself had been created,
   * so every retry minted another one.
   */
  domainId: string;
}

export async function createReportShare(input: {
  organizationId: string;
  domainId: string;
  createdById: string | undefined;
  includeForensics: boolean;
  includeSources: boolean;
  expiresInDays?: number;
}): Promise<CreatedShare | null> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId: input.organizationId }, ...domainRef(input.domainId) },
    select: { id: true, clientId: true },
  });

  if (!domain) {
    return null;
  }

  const days = clamp(input.expiresInDays ?? defaultShareDays, 1, maximumShareDays);
  const token = randomBytes(32).toString('base64url');

  const share = await prisma.reportShare.create({
    data: {
      token,
      organizationId: input.organizationId,
      clientId: domain.clientId,
      domainId: domain.id,
      createdById: input.createdById ?? null,
      includeForensics: input.includeForensics,
      includeSources: input.includeSources,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    },
    select: { id: true, token: true, expiresAt: true, includeForensics: true, includeSources: true },
  });

  return {
    ...share,
    domainId: domain.id,
    url: `/api/reports/share/${share.token}`,
  };
}

export async function listReportShares(organizationId: string, options: { limit?: number; cursor?: string } = {}) {
  const limit = resolveLimit(options.limit);
  const rows = await prisma.reportShare.findMany({
    where: { organizationId },
    select: {
      id: true,
      token: true,
      expiresAt: true,
      revokedAt: true,
      lastViewedAt: true,
      viewCount: true,
      includeForensics: true,
      includeSources: true,
      createdAt: true,
      domain: { select: { id: true, name: true } },
      client: { select: { id: true, name: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  return { rows, limit };
}

export async function revokeReportShare(organizationId: string, shareId: string): Promise<boolean> {
  const result = await prisma.reportShare.updateMany({
    where: { id: shareId, organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return result.count > 0;
}

/**
 * Removes a REVOKED share link's row.
 *
 * Revoking stops the link working and keeps the row so the workspace can show
 * what was sent and to whom. Removing the row afterwards is a different act, and
 * a separate one for a reason: a share link is a published address. Leaving dead
 * tokens lying around in a list an operator reads forever is how one of them
 * gets pasted into a ticket months later.
 *
 * Refused while the link is still live, so this can never be used to kill a
 * working share without the revocation appearing in the trail.
 *
 * `viewCount` is copied into the audit detail because it is the one piece of the
 * row that says somebody actually read the report, and it dies with the row.
 */
export async function deleteRevokedReportShare(
  organizationId: string,
  shareId: string,
  actorUserId?: string | null,
): Promise<'deleted' | 'not_found' | 'still_active'> {
  const existing = await prisma.reportShare.findFirst({
    where: { id: shareId, organizationId },
    select: {
      id: true,
      revokedAt: true,
      viewCount: true,
      client: { select: { name: true } },
      domain: { select: { name: true } },
    },
  });

  if (!existing) {
    return 'not_found';
  }

  if (existing.revokedAt === null) {
    return 'still_active';
  }

  await prisma.reportShare.delete({ where: { id: existing.id } });

  await recordAuditEvent({
    organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'REPORT_SHARE_DELETED',
    targetType: 'report_share',
    targetId: existing.id,
    detail: {
      clientName: existing.client.name,
      domainName: existing.domain.name,
      viewCount: existing.viewCount,
      revokedAt: existing.revokedAt.toISOString(),
    },
  });

  return 'deleted';
}

/** Every revoked share link in the workspace, removed in one call. */
export async function deleteAllRevokedReportShares(
  organizationId: string,
  actorUserId?: string | null,
): Promise<number> {
  const revoked = await prisma.reportShare.findMany({
    where: { organizationId, revokedAt: { not: null } },
    select: { id: true },
  });

  if (revoked.length === 0) {
    return 0;
  }

  const result = await prisma.reportShare.deleteMany({
    where: { id: { in: revoked.map((row) => row.id) } },
  });

  await recordAuditEvent({
    organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'REPORT_SHARE_DELETED',
    targetType: 'report_share',
    detail: { bulk: true, removed: result.count },
  });

  return result.count;
}

export interface PublicReportView {
  sharedFor: { organization: string; client: string; domain: string };
  generatedAt: string;
  expiresAt: string;
  policy: { published: string | null; reportingConfigured: boolean; recommended: string };
  health: { score: number | null; passRatePercent: number | null; messagesObserved: number; daysObserved: number };
  reporting: { reportsReceived: number; lastReportAt: string | null; daysSinceLastReport: number | null };
  activity: { dailyReports: { date: string; reports: number; messages: number }[]; spikes: unknown[] };
  sources: { sourceIp: string; failedMessages: number; totalMessages: number; risk: string; topSendingDomain: string | null }[];
  forensic: { included: boolean; reportCount: number; rejectedMessages: number; affectedRecipients: number } | null;
}

export async function getPublicReport(token: string, now = new Date()): Promise<PublicReportView | null> {
  const share = await prisma.reportShare.findUnique({
    where: { token },
    select: {
      id: true,
      organizationId: true,
      domainId: true,
      includeForensics: true,
      includeSources: true,
      expiresAt: true,
      revokedAt: true,
      organization: { select: { name: true } },
      client: { select: { name: true } },
    },
  });

  if (!share || share.revokedAt || share.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const domain = await prisma.domain.findFirst({
    where: { id: share.domainId, client: { organizationId: share.organizationId } },
    select: { id: true, name: true, score: true, dmarcPolicy: true, dmarcRecord: true },
  });

  if (!domain) {
    return null;
  }

  const insights = await getDomainInsights(share.organizationId, share.domainId);
  if (!insights) {
    return null;
  }

  const readiness = await assessPolicyReadiness(share.organizationId, share.domainId, insights);

  await prisma.reportShare.update({
    where: { id: share.id },
    data: { lastViewedAt: now, viewCount: { increment: 1 } },
  });

  const tags = readDmarcRecord(domain.dmarcRecord);
  const lastReportAt = insights.aggregate.lastReportAt ?? insights.forensic.lastReportAt;

  return {
    sharedFor: {
      organization: share.organization.name,
      client: share.client.name,
      domain: domain.name,
    },
    generatedAt: now.toISOString(),
    expiresAt: share.expiresAt.toISOString(),
    policy: {
      published: domain.dmarcPolicy,
      reportingConfigured: hasAggregateReporting(tags),
      recommended: readiness.ready ? readiness.level : 'none',
    },
    health: {
      score: domain.score,
      passRatePercent: readiness.passRatePercent,
      messagesObserved: insights.aggregate.messageCount,
      daysObserved: readiness.daysObserved,
    },
    reporting: {
      reportsReceived: insights.aggregate.reportCount,
      lastReportAt,
      daysSinceLastReport: lastReportAt
        ? Math.round(((now.getTime() - new Date(lastReportAt).getTime()) / 86_400_000) * 100) / 100
        : null,
    },
    activity: {
      dailyReports: insights.trends.points.map((point) => ({
        date: point.date,
        reports: point.reportsReceived,
        messages: point.messagesObserved,
      })),
      spikes: insights.trends.spikes,
    },
    sources: share.includeSources
      ? insights.sources.slice(0, 10).map((source) => ({
          sourceIp: source.sourceIp,
          failedMessages: source.failedMessages,
          totalMessages: source.totalMessages,
          risk: source.risk,
          topSendingDomain: source.topSendingDomain,
        }))
      : [],
    forensic: share.includeForensics
      ? {
          included: true,
          reportCount: insights.forensic.count,
          rejectedMessages: insights.forensic.rejectedMessages,
          affectedRecipients: insights.forensic.affectedRecipients,
        }
      : null,
  };
}
