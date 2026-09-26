import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { parseDmarcReport } from './report-parser.service.js';

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

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
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
    const report = await prisma.dmarcReport.create({
      data: {
        domainId: domain.id,
        reportType: 'AGGREGATE',
        fingerprint: parsed.fingerprint,
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

export async function listDomainReports(organizationId: string, domainId: string): Promise<PersistedReport[]> {
  return prisma.dmarcReport.findMany({
    where: {
      domainId,
      domain: { client: { organizationId } },
    },
    include: reportInclude,
    orderBy: { receivedAt: 'desc' },
  });
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
