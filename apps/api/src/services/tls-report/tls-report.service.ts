import type { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { domainRef } from '../domain-ref.js';
import { reportRetentionExpiry } from '../privacy.service.js';
import { emitEvent } from '../webhook.service.js';
import { parseTlsReport, type ParsedTlsReport } from './parse.js';

const outcomeSelect = { id: true, policyDomain: true } as const;

export type StoredTlsReport = Prisma.TlsReportGetPayload<{ select: typeof outcomeSelect }>;

export type IngestTlsOutcome =
  | { status: 'not_found' }
  | { status: 'not_verified' }
  | { status: 'domain_mismatch'; reportDomain: string }
  | { status: 'duplicate'; report: StoredTlsReport }
  | { status: 'created'; report: StoredTlsReport };

export type TlsMailboxOutcome =
  | { status: 'domain_not_found'; reportDomain: string }
  | { status: 'ambiguous_domain'; reportDomain: string }
  | IngestTlsOutcome;

const purgeIntervalMs = 60 * 60 * 1000;
let lastPurgeAt = 0;

export async function purgeExpiredTlsReports(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastPurgeAt < purgeIntervalMs) {
    return 0;
  }
  lastPurgeAt = now;
  const result = await prisma.tlsReport.deleteMany({
    where: { retentionExpiresAt: { lte: new Date() } },
  });
  return result.count;
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

async function findExistingTlsReport(
  parsed: Pick<ParsedTlsReport, 'fingerprint' | 'reportIdentity'>,
): Promise<StoredTlsReport | null> {
  const byIdentity = await prisma.tlsReport.findUnique({
    where: { reportIdentity: parsed.reportIdentity },
    select: outcomeSelect,
  });
  if (byIdentity) {
    return byIdentity;
  }
  return prisma.tlsReport.findUnique({
    where: { fingerprint: parsed.fingerprint },
    select: outcomeSelect,
  });
}

function nestedPolicies(parsed: ParsedTlsReport): Prisma.TlsReportPolicyCreateWithoutReportInput[] {
  return parsed.policies.map((policy) => ({
    policyType: policy.policyType,
    policyString: policy.policyString,
    mxHost: policy.mxHost,
    successfulSessions: BigInt(policy.successfulSessions),
    failedSessions: BigInt(policy.failedSessions),
    failures: {
      create: policy.failures.map((failure) => ({
        resultType: failure.resultType,
        sendingMtaIp: failure.sendingMtaIp,
        receivingMxHostname: failure.receivingMxHostname,
        receivingMxHelo: failure.receivingMxHelo,
        receivingIp: failure.receivingIp,
        failedSessions: BigInt(failure.failedSessions),
        additionalInformation: failure.additionalInformation,
        failureReasonCode: failure.failureReasonCode,
      })),
    },
  }));
}

export async function ingestTlsReport(input: {
  organizationId: string;
  domainId: string;
  json: string;
}): Promise<IngestTlsOutcome> {
  const domain = await prisma.domain.findFirst({
    where: {
      ...domainRef(input.domainId),
      client: { organizationId: input.organizationId },
    },
    select: { id: true, name: true, status: true },
  });
  if (!domain) {
    return { status: 'not_found' };
  }
  if (domain.status !== 'VERIFIED') {
    return { status: 'not_verified' };
  }

  const parsed = parseTlsReport(input.json);
  if (parsed.policyDomain !== domain.name.toLowerCase().replace(/\.+$/, '')) {
    return { status: 'domain_mismatch', reportDomain: parsed.policyDomain };
  }

  const existing = await findExistingTlsReport(parsed);
  if (existing) {
    return { status: 'duplicate', report: existing };
  }

  try {
    await purgeExpiredTlsReports();

    const report = await prisma.tlsReport.create({
      data: {
        domainId: domain.id,
        fingerprint: parsed.fingerprint,
        reportIdentity: parsed.reportIdentity,
        reportId: parsed.reportId,
        organizationName: parsed.organizationName,
        contactInfo: parsed.contactInfo,
        policyDomain: parsed.policyDomain,
        dateRangeBegin: parsed.dateRangeBegin,
        dateRangeEnd: parsed.dateRangeEnd,
        successfulSessions: BigInt(parsed.successfulSessions),
        failedSessions: BigInt(parsed.failedSessions),
        truncated: parsed.truncated,
        retentionExpiresAt: reportRetentionExpiry(),
        policies: { create: nestedPolicies(parsed) },
      },
      select: { ...outcomeSelect, receivedAt: true },
    });

    try {
      await emitEvent(input.organizationId, 'tlsrpt.received', {
        reportId: report.id,
        domainId: domain.id,
        domainName: domain.name,
        organizationName: parsed.organizationName,
        successfulSessions: parsed.successfulSessions,
        failedSessions: parsed.failedSessions,
        receivedAt: report.receivedAt.toISOString(),
      });
    } catch (error) {
      // The report is stored; a webhook failure must not turn that into an
      // intake failure.
      console.error(
        `[tls-report] webhook delivery failed for ${report.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    return { status: 'created', report };
  } catch (error) {
    if (isUniqueConstraint(error)) {
      const duplicate = await findExistingTlsReport(parsed);
      if (duplicate) {
        return { status: 'duplicate', report: duplicate };
      }
    }
    throw error;
  }
}

export async function ingestTlsReportByPolicyDomain(json: string): Promise<TlsMailboxOutcome> {
  const parsed = parseTlsReport(json);
  const domains = await prisma.domain.findMany({
    where: { name: parsed.policyDomain, status: 'VERIFIED' },
    select: { id: true, client: { select: { organizationId: true } } },
  });
  if (domains.length === 0) {
    return { status: 'domain_not_found', reportDomain: parsed.policyDomain };
  }
  if (domains.length > 1) {
    return { status: 'ambiguous_domain', reportDomain: parsed.policyDomain };
  }
  const domain = domains[0]!;
  return ingestTlsReport({
    organizationId: domain.client.organizationId,
    domainId: domain.id,
    json,
  });
}
