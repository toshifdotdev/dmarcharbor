import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { resolveLimit } from '../utils/pagination.js';
import { parseDmarcReport } from './report-parser.service.js';
import { reportRetentionExpiry } from './privacy.service.js';

const reportInclude = {
  domain: {
    select: {
      id: true,
      name: true,
      status: true,
      client: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  },
  records: {
    include: {
      authResults: true,
    },
    orderBy: {
      id: 'asc',
    },
  },
} as const;

type PersistedReport = Prisma.DmarcReportGetPayload<{ include: typeof reportInclude }>;

type IngestReportInput = {
  organizationId: string;
  domainId: string;
  xml: string;
};

export type IngestReportOutcome =
  | { status: 'not_found' }
  | { status: 'not_verified' }
  | { status: 'domain_mismatch'; reportDomain: string }
  | { status: 'duplicate'; report: PersistedReport }
  | { status: 'created'; report: PersistedReport };

export type MailboxIngestOutcome =
  | { status: 'domain_not_found'; reportDomain: string }
  | { status: 'ambiguous_domain'; reportDomain: string }
  | IngestReportOutcome;

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

const reportPurgeIntervalMs = 60 * 60 * 1000;
let lastReportPurgeAt = 0;

export async function purgeExpiredReports(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastReportPurgeAt < reportPurgeIntervalMs) {
    return 0;
  }

  lastReportPurgeAt = now;
  const result = await prisma.dmarcReport.deleteMany({
    where: { retentionExpiresAt: { lte: new Date() } },
  });

  return result.count;
}

export async function ingestDmarcReport(input: IngestReportInput): Promise<IngestReportOutcome> {
  const domain = await prisma.domain.findFirst({
    where: {
      id: input.domainId,
      client: { organizationId: input.organizationId },
    },
    select: {
      id: true,
      name: true,
      status: true,
    },
  });

  if (!domain) {
    return { status: 'not_found' };
  }

  if (domain.status !== 'VERIFIED') {
    return { status: 'not_verified' };
  }

  const parsed = parseDmarcReport(input.xml);

  if (parsed.policyDomain !== domain.name) {
    return { status: 'domain_mismatch', reportDomain: parsed.policyDomain };
  }

  const existing = await prisma.dmarcReport.findUnique({
    where: { fingerprint: parsed.fingerprint },
    include: reportInclude,
  });

  if (existing) {
    return { status: 'duplicate', report: existing };
  }

  try {
    await purgeExpiredReports();

    const report = await prisma.dmarcReport.create({
      data: {
        domainId: domain.id,
        reportType: 'AGGREGATE',
        fingerprint: parsed.fingerprint,
        retentionExpiresAt: reportRetentionExpiry(),
        reportId: parsed.reportId,
        reportingOrganization: parsed.reportingOrganization,
        reportingEmail: parsed.reportingEmail,
        extraContactInfo: parsed.extraContactInfo,
        dateRangeBegin: parsed.dateRangeBegin,
        dateRangeEnd: parsed.dateRangeEnd,
        policyDomain: parsed.policyDomain,
        policyAdkim: parsed.policyAdkim,
        policyAspf: parsed.policyAspf,
        policyP: parsed.policyP,
        policySp: parsed.policySp,
        policyFraction: parsed.policyFraction,
        reportError: parsed.reportError,
        recordCount: parsed.records.length,
        records: {
          create: parsed.records.map((record) => ({
            sourceIp: record.sourceIp,
            messageCount: record.messageCount,
            disposition: record.disposition,
            dkimResult: record.dkimResult,
            spfResult: record.spfResult,
            headerFrom: record.headerFrom,
            envelopeFrom: record.envelopeFrom,
            policyReason: record.policyReason,
            authResults: {
              create: record.authResults.map((authResult) => ({
                type: authResult.type,
                domain: authResult.domain,
                selector: authResult.selector,
                scope: authResult.scope,
                result: authResult.result,
              })),
            },
          })),
        },
      },
      include: reportInclude,
    });

    return { status: 'created', report };
  } catch (error) {
    if (isUniqueConstraint(error)) {
      const duplicate = await prisma.dmarcReport.findUnique({
        where: { fingerprint: parsed.fingerprint },
        include: reportInclude,
      });
      if (duplicate) {
        return { status: 'duplicate', report: duplicate };
      }
    }

    throw error;
  }
}

export async function ingestDmarcReportByPolicyDomain(xml: string): Promise<MailboxIngestOutcome> {
  const parsed = parseDmarcReport(xml);
  const domains = await prisma.domain.findMany({
    where: {
      name: parsed.policyDomain,
      status: 'VERIFIED',
    },
    select: {
      id: true,
      client: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (domains.length === 0) {
    return { status: 'domain_not_found', reportDomain: parsed.policyDomain };
  }

  if (domains.length > 1) {
    return { status: 'ambiguous_domain', reportDomain: parsed.policyDomain };
  }

  return ingestDmarcReport({
    organizationId: domains[0].client.organizationId,
    domainId: domains[0].id,
    xml,
  });
}

export async function listDomainReports(
  organizationId: string,
  domainId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ rows: PersistedReport[]; limit: number }> {
  const limit = resolveLimit(options.limit);
  const rows = await prisma.dmarcReport.findMany({
    where: {
      domainId,
      domain: { client: { organizationId } },
    },
    include: reportInclude,
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  return { rows, limit };
}

export async function getDmarcReport(organizationId: string, reportId: string): Promise<PersistedReport | null> {
  return prisma.dmarcReport.findFirst({
    where: {
      id: reportId,
      domain: { client: { organizationId } },
    },
    include: reportInclude,
  });
}
