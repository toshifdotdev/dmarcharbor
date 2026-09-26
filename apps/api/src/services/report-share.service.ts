import { randomBytes } from 'node:crypto';
import { prisma } from '../database/prisma.js';
import { readDmarcRecord } from '../scanner/dmarc-tags.js';
import { getDomainInsights } from './report-intelligence.service.js';
import { resolveLimit } from '../utils/pagination.js';
import { assessPolicyReadiness } from './onboarding.service.js';

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
    where: { id: input.domainId, client: { organizationId: input.organizationId } },
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
      reportingConfigured: tags.aggregateTargets.length > 0,
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
