import { prisma } from '../../database/prisma.js';
import { tlsRecordForDomain, type TlsRecordView } from './record.js';

function num(value: bigint | number | string | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return value ?? 0;
}

export interface TlsReportPolicySummary {
  id: string;
  policyType: string;
  policyString: string | null;
  mxHost: string | null;
  successfulSessions: number;
  failedSessions: number;
}

export interface TlsReportListItem {
  id: string;
  reportId: string;
  organizationName: string;
  contactInfo: string | null;
  policyDomain: string;
  dateRangeBegin: string;
  dateRangeEnd: string;
  successfulSessions: number;
  failedSessions: number;
  truncated: boolean;
  receivedAt: string;
  policies: TlsReportPolicySummary[];
}

export interface TlsReportDetail extends TlsReportListItem {
  policies: Array<
    TlsReportPolicySummary & {
      failures: Array<{
        id: string;
        resultType: string;
        sendingMtaIp: string | null;
        receivingMxHostname: string | null;
        receivingMxHelo: string | null;
        receivingIp: string | null;
        failedSessions: number;
        additionalInformation: string | null;
        failureReasonCode: string | null;
      }>;
    }
  >;
}

export interface TlsReportSummary {
  days: number;
  reportCount: number;
  successfulSessions: number;
  failedSessions: number;
  failureSharePercent: number | null;
  lastReportAt: string | null;
  byResultType: Array<{ resultType: string; failedSessions: number; reporters: string[] }>;
  byMxHost: Array<{ receivingMxHostname: string; failedSessions: number; resultTypes: string[] }>;
  byPolicyType: Array<{ policyType: string; successfulSessions: number; failedSessions: number }>;
  record: TlsRecordView;
}

export interface TlsReportPage {
  rows: TlsReportListItem[];
  limit: number;
}

export async function listDomainTlsReports(
  organizationId: string,
  domainId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<TlsReportPage> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const rows = await prisma.tlsReport.findMany({
    where: { domainId, domain: { client: { organizationId } } },
    include: { policies: { orderBy: { id: 'asc' } } },
    orderBy: [{ dateRangeBegin: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  return {
    limit,
    rows: rows.map((row) => ({
      id: row.id,
      reportId: row.reportId,
      organizationName: row.organizationName,
      contactInfo: row.contactInfo,
      policyDomain: row.policyDomain,
      dateRangeBegin: row.dateRangeBegin.toISOString(),
      dateRangeEnd: row.dateRangeEnd.toISOString(),
      successfulSessions: num(row.successfulSessions),
      failedSessions: num(row.failedSessions),
      truncated: row.truncated,
      receivedAt: row.receivedAt.toISOString(),
      policies: row.policies.map((policy) => ({
        id: policy.id,
        policyType: policy.policyType,
        policyString: policy.policyString,
        mxHost: policy.mxHost,
        successfulSessions: num(policy.successfulSessions),
        failedSessions: num(policy.failedSessions),
      })),
    })),
  };
}

export async function getTlsReport(
  organizationId: string,
  reportId: string,
): Promise<TlsReportDetail | null> {
  const row = await prisma.tlsReport.findFirst({
    where: { id: reportId, domain: { client: { organizationId } } },
    include: {
      policies: {
        orderBy: { id: 'asc' },
        include: { failures: { orderBy: { id: 'asc' } } },
      },
    },
  });
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    reportId: row.reportId,
    organizationName: row.organizationName,
    contactInfo: row.contactInfo,
    policyDomain: row.policyDomain,
    dateRangeBegin: row.dateRangeBegin.toISOString(),
    dateRangeEnd: row.dateRangeEnd.toISOString(),
    successfulSessions: num(row.successfulSessions),
    failedSessions: num(row.failedSessions),
    truncated: row.truncated,
    receivedAt: row.receivedAt.toISOString(),
    policies: row.policies.map((policy) => ({
      id: policy.id,
      policyType: policy.policyType,
      policyString: policy.policyString,
      mxHost: policy.mxHost,
      successfulSessions: num(policy.successfulSessions),
      failedSessions: num(policy.failedSessions),
      failures: policy.failures.map((failure) => ({
        id: failure.id,
        resultType: failure.resultType,
        sendingMtaIp: failure.sendingMtaIp,
        receivingMxHostname: failure.receivingMxHostname,
        receivingMxHelo: failure.receivingMxHelo,
        receivingIp: failure.receivingIp,
        failedSessions: num(failure.failedSessions),
        additionalInformation: failure.additionalInformation,
        failureReasonCode: failure.failureReasonCode,
      })),
    })),
  };
}

export async function getTlsReportSummary(
  organizationId: string,
  domainId: string,
  days: number,
): Promise<TlsReportSummary | null> {
  const domain = await prisma.domain.findFirst({
    where: { id: domainId, client: { organizationId } },
    select: { id: true, name: true, client: { select: { reportToken: true } } },
  });
  if (!domain) {
    return null;
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [totals, byPolicyType, byResultType, byMxHost, record] = await Promise.all([
    prisma.tlsReport.aggregate({
      where: { domainId, dateRangeBegin: { gte: since } },
      _count: { _all: true },
      _sum: { successfulSessions: true, failedSessions: true },
      _max: { receivedAt: true },
    }),
    prisma.tlsReportPolicy.groupBy({
      by: ['policyType'],
      where: { report: { domainId, dateRangeBegin: { gte: since } } },
      _sum: { successfulSessions: true, failedSessions: true },
      orderBy: { policyType: 'asc' },
    }),
    prisma.$queryRaw<
      Array<{ resultType: string; failedSessions: bigint; reporters: string[] }>
    >`
      SELECT f."resultType" AS "resultType",
             SUM(f."failedSessions")::bigint AS "failedSessions",
             ARRAY_AGG(DISTINCT r."organizationName") AS "reporters"
      FROM "tls_report_failure" f
      JOIN "tls_report_policy" p ON p."id" = f."policyId"
      JOIN "tls_report" r ON r."id" = p."reportId"
      WHERE r."domainId" = ${domainId} AND r."dateRangeBegin" >= ${since}
      GROUP BY f."resultType"
      ORDER BY SUM(f."failedSessions") DESC
    `,
    /**
     * Grouped by the mail server that actually failed: each failure detail's
     * receiving-mx-hostname. The policy's mx-host is the MTA-STS pattern
     * ("*.mail.example"), which names no server, so it is only the fallback
     * when a reporter leaves the hostname out.
     */
    prisma.$queryRaw<
      Array<{ receivingMxHostname: string; failedSessions: bigint; resultTypes: string[] }>
    >`
      SELECT COALESCE(f."receivingMxHostname", p."mxHost") AS "receivingMxHostname",
             SUM(f."failedSessions")::bigint AS "failedSessions",
             ARRAY_AGG(DISTINCT f."resultType") AS "resultTypes"
      FROM "tls_report_failure" f
      JOIN "tls_report_policy" p ON p."id" = f."policyId"
      JOIN "tls_report" r ON r."id" = p."reportId"
      WHERE r."domainId" = ${domainId}
        AND r."dateRangeBegin" >= ${since}
        AND COALESCE(f."receivingMxHostname", p."mxHost") IS NOT NULL
      GROUP BY COALESCE(f."receivingMxHostname", p."mxHost")
      ORDER BY SUM(f."failedSessions") DESC
      LIMIT 20
    `,
    tlsRecordForDomain(domain.id, domain.name, domain.client.reportToken),
  ]);

  const successfulSessions = num(totals._sum.successfulSessions);
  const failedSessions = num(totals._sum.failedSessions);
  const totalSessions = BigInt(successfulSessions) + BigInt(failedSessions);

  return {
    days,
    reportCount: totals._count._all,
    successfulSessions,
    failedSessions,
    failureSharePercent:
      totalSessions === 0n ? null : Number((BigInt(failedSessions) * 10_000n) / totalSessions) / 100,
    lastReportAt: totals._max.receivedAt?.toISOString() ?? null,
    byResultType: byResultType.map((row) => ({
      resultType: row.resultType,
      failedSessions: num(row.failedSessions),
      reporters: [...row.reporters].sort(),
    })),
    byMxHost: byMxHost.map((row) => ({
      receivingMxHostname: row.receivingMxHostname,
      failedSessions: num(row.failedSessions),
      resultTypes: [...row.resultTypes].sort(),
    })),
    byPolicyType: byPolicyType.map((row) => ({
      policyType: row.policyType,
      successfulSessions: num(row._sum.successfulSessions),
      failedSessions: num(row._sum.failedSessions),
    })),
    record,
  };
}
