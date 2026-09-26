import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { readDmarcRecord } from '../scanner/dmarc-tags.js';
import { normalizeDomain } from '../scanner/domain.js';
import { parseForensicReport } from './forensic-report-parser.service.js';
import { forensicRedactionVersion, forensicRetentionDays, forensicRetentionExpiry } from './privacy.service.js';

const forensicInclude = {
  domain: {
    select: {
      id: true,
      name: true,
      status: true,
      collectForensicReports: true,
      client: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  },
} as const;

type PersistedForensic = Prisma.DmarcForensicReportGetPayload<{ include: typeof forensicInclude }>;

type IngestForensicInput = {
  organizationId: string;
  domainId: string;
  rawEmail: string;
};

export type ForensicIngestOutcome =
  | { status: 'not_found' }
  | { status: 'not_verified' }
  | { status: 'forensics_not_enabled' }
  | { status: 'ruf_not_configured' }
  | { status: 'domain_mismatch'; reportedDomain: string }
  | { status: 'duplicate'; forensic: PersistedForensic }
  | { status: 'created'; forensic: PersistedForensic };

export type ForensicMailboxIngestOutcome =
  | { status: 'domain_not_found'; reportedDomain: string }
  | { status: 'ambiguous_domain'; reportedDomain: string }
  | ForensicIngestOutcome;

const purgeIntervalMs = 60 * 60 * 1000;
let lastPurgeAt = 0;

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : (value as Prisma.InputJsonValue);
}

export function forensicCollectionEnabled(domain: { collectForensicReports: boolean }): boolean {
  return domain.collectForensicReports;
}

export function rufConfigured(domain: { dmarcRecord: string | null }): boolean {
  return readDmarcRecord(domain.dmarcRecord).forensicTargets.length > 0;
}

export async function purgeExpiredForensicReports(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastPurgeAt < purgeIntervalMs) {
    return 0;
  }

  lastPurgeAt = now;
  const result = await prisma.dmarcForensicReport.deleteMany({
    where: { retentionExpiresAt: { lte: new Date() } },
  });

  return result.count;
}

export async function ingestForensicReport(input: IngestForensicInput): Promise<ForensicIngestOutcome> {
  const domain = await prisma.domain.findFirst({
    where: {
      id: input.domainId,
      client: { organizationId: input.organizationId },
    },
    select: {
      id: true,
      name: true,
      status: true,
      dmarcRecord: true,
      collectForensicReports: true,
    },
  });

  if (!domain) {
    return { status: 'not_found' };
  }

  if (domain.status !== 'VERIFIED') {
    return { status: 'not_verified' };
  }

  const parsed = parseForensicReport(input.rawEmail);

  if (normalizeDomain(parsed.reportedDomain) !== domain.name) {
    return { status: 'domain_mismatch', reportedDomain: parsed.reportedDomain };
  }

  if (!forensicCollectionEnabled(domain)) {
    return { status: 'forensics_not_enabled' };
  }

  if (!rufConfigured(domain)) {
    return { status: 'ruf_not_configured' };
  }

  await purgeExpiredForensicReports();

  const existing = await prisma.dmarcForensicReport.findUnique({
    where: { fingerprint: parsed.fingerprint },
    include: forensicInclude,
  });

  if (existing) {
    return { status: 'duplicate', forensic: existing };
  }

  try {
    const forensic = await prisma.dmarcForensicReport.create({
      data: {
        domainId: domain.id,
        fingerprint: parsed.fingerprint,
        feedbackType: parsed.feedbackType,
        reportedDomain: parsed.reportedDomain,
        sourceIp: parsed.sourceIp,
        sourcePort: parsed.sourcePort,
        disposition: parsed.disposition,
        deliveryAction: parsed.deliveryAction,
        deliveryStatus: parsed.deliveryStatus,
        dkimResult: parsed.dkimResult,
        spfResult: parsed.spfResult,
        authResults: toJson(parsed.authResults),
        reportingMta: parsed.reportingMta,
        dsnGateway: parsed.dsnGateway,
        remoteMta: parsed.remoteMta,
        userAgent: parsed.userAgent,
        diagnosticCodes: toJson(parsed.diagnosticCodes),
        recipientCount: parsed.recipientCount,
        recipientPseudonyms: toJson(parsed.recipientPseudonyms),
        envelopeFromPseudonym: parsed.envelopeFromPseudonym,
        messageIdPseudonym: parsed.messageIdPseudonym,
        subjectPseudonym: parsed.subjectPseudonym,
        originalMessageDate: parsed.originalMessageDate,
        arrivedAt: parsed.arrivedAt,
        hasOriginalHeaders: parsed.hasOriginalHeaders,
        hasOriginalMessageIncluded: parsed.hasOriginalMessageIncluded,
        redactionVersion: forensicRedactionVersion,
        retentionExpiresAt: forensicRetentionExpiry(),
      },
      include: forensicInclude,
    });

    return { status: 'created', forensic };
  } catch (error) {
    if (isUniqueConstraint(error)) {
      const duplicate = await prisma.dmarcForensicReport.findUnique({
        where: { fingerprint: parsed.fingerprint },
        include: forensicInclude,
      });
      if (duplicate) {
        return { status: 'duplicate', forensic: duplicate };
      }
    }

    throw error;
  }
}

export async function ingestForensicReportByReportedDomain(rawEmail: string): Promise<ForensicMailboxIngestOutcome> {
  const parsed = parseForensicReport(rawEmail);
  const reportedDomain = normalizeDomain(parsed.reportedDomain);
  const domains = await prisma.domain.findMany({
    where: {
      name: reportedDomain,
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
    return { status: 'domain_not_found', reportedDomain };
  }

  if (domains.length > 1) {
    return { status: 'ambiguous_domain', reportedDomain };
  }

  return ingestForensicReport({
    organizationId: domains[0].client.organizationId,
    domainId: domains[0].id,
    rawEmail,
  });
}

export async function listDomainForensics(
  organizationId: string,
  domainId: string,
  limit = 100,
): Promise<PersistedForensic[]> {
  return prisma.dmarcForensicReport.findMany({
    where: {
      domainId,
      domain: { client: { organizationId } },
    },
    include: forensicInclude,
    orderBy: { receivedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

export async function getForensicReport(organizationId: string, forensicId: string): Promise<PersistedForensic | null> {
  return prisma.dmarcForensicReport.findFirst({
    where: {
      id: forensicId,
      domain: { client: { organizationId } },
    },
    include: forensicInclude,
  });
}

export async function purgeForensicReports(organizationId: string, domainId: string): Promise<number> {
  const domain = await prisma.domain.findFirst({
    where: {
      id: domainId,
      client: { organizationId },
    },
    select: { id: true },
  });

  if (!domain) {
    return 0;
  }

  const result = await prisma.dmarcForensicReport.deleteMany({ where: { domainId: domain.id } });
  return result.count;
}

export async function deleteForensicReport(organizationId: string, forensicId: string): Promise<boolean> {
  const existing = await prisma.dmarcForensicReport.findFirst({
    where: {
      id: forensicId,
      domain: { client: { organizationId } },
    },
    select: { id: true },
  });

  if (!existing) {
    return false;
  }

  await prisma.dmarcForensicReport.delete({ where: { id: existing.id } });
  return true;
}

export function forensicRetentionSummary(): { retentionDays: number; redactionVersion: number } {
  return { retentionDays: forensicRetentionDays(), redactionVersion: forensicRedactionVersion };
}

export async function setForensicCollection(
  organizationId: string,
  domainId: string,
  collectForensicReports: boolean,
): Promise<
  | { status: 'not_found' }
  | {
      status: 'updated';
      domain: { id: string; name: string; collectForensicReports: boolean; rufConfigured: boolean };
    }
> {
  const domain = await prisma.domain.findFirst({
    where: {
      id: domainId,
      client: { organizationId },
    },
    select: {
      id: true,
      name: true,
      dmarcRecord: true,
      collectForensicReports: true,
    },
  });

  if (!domain) {
    return { status: 'not_found' };
  }

  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: { collectForensicReports },
    select: {
      id: true,
      name: true,
      collectForensicReports: true,
    },
  });

  return {
    status: 'updated',
    domain: { ...updated, rufConfigured: rufConfigured(domain) },
  };
}
