import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { env } from '../../config/env.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveBranding } from '../branding.service.js';
import { withPdfSlot } from '../pdf-concurrency.js';
import { reportRetentionDays } from '../privacy.service.js';
import { attributeSourceIp, type AuthSignal, type CachedIntel } from '../senders/attribution.js';
import { normaliseIpAddress } from '../senders/ip-intel.service.js';
import { loadMonthlyReportLogo, type ReportLogo } from './monthly-report-logo.js';
import {
  monthlyReportFilename,
  monthlyReportReference,
  parseMonthlyPeriod,
  periodFromKey,
  type MonthlyPeriod,
  MonthlyReportError,
} from './monthly-period.js';
import {
  renderMonthlyReportPdf,
  type MonthlyChangeFacts,
  type MonthlyDomainFacts,
  type MonthlyFacts,
  type MonthlyReportBranding,
  type MonthlySourceFacts,
} from './monthly-report-pdf.js';

/** The largest report this service will store. A month of evidence is far smaller. */
export const maxMonthlyReportBytes = 4 * 1024 * 1024;
export const monthlyReportLinkDays = 30;
const maximumDomainsInDocument = 500;
const maximumChangesInDocument = 200;
const monthlyDocumentVersion = '1.0';
const reportScope = 'MONTHLY_REPORT';
const packScope = 'CLIENT';

function toNumber(value: bigint | number | null | undefined): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

function normalisePolicy(value: string | null | undefined): 'none' | 'quarantine' | 'reject' | null {
  const normalised = (value ?? '').trim().toLowerCase();
  return normalised === 'none' || normalised === 'quarantine' || normalised === 'reject'
    ? normalised
    : null;
}

interface ClientForReport {
  id: string;
  name: string;
  createdAt: Date;
  organizationId: string;
  organization: { id: string; name: string };
}

async function loadClient(clientId: string, organizationId: string): Promise<ClientForReport> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      organizationId: true,
      organization: { select: { id: true, name: true } },
    },
  });
  if (!client) {
    throw new MonthlyReportError('That client is not in this workspace.', 'CLIENT_NOT_FOUND', 404);
  }
  return client;
}

function policyFromScan(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  const dmarc = (result as { dmarc?: unknown }).dmarc;
  if (!dmarc || typeof dmarc !== 'object' || Array.isArray(dmarc)) {
    return null;
  }
  const row = dmarc as { status?: unknown; policy?: unknown; testing?: unknown };
  if (row.status === 'found') {
    const policy = normalisePolicy(typeof row.policy === 'string' ? row.policy : null);
    if (!policy) {
      return 'not known';
    }
    return row.testing === true && policy !== 'none' ? 'testing' : policy;
  }
  if (row.status === 'missing') {
    return 'no record';
  }
  return 'not known';
}

/**
 * The policy rule, in one place and testable without a database.
 *
 * A completed scan is the strongest evidence: it is a direct read of the
 * record. If its result says the record was missing, that is "no record", not
 * an invitation to use an older report. Only when no scan result exists at all
 * does the newest report in the month supply a policy.
 */
export function monthlyPolicyLabel(scanResult: unknown, reportPolicy: string | null): string {
  const fromScan = policyFromScan(scanResult);
  if (fromScan !== null) {
    return fromScan;
  }
  return normalisePolicy(reportPolicy) ?? 'not known';
}

function policyAtPeriod(scanRows: ScanPolicyRow[], reportRows: ReportPolicyRow[], domainIds: string[]): Map<string, string> {
  const scans = new Map(scanRows.map((row) => [row.domainId, row.result]));
  const reports = new Map(reportRows.map((row) => [row.domainId, row.policyP]));
  const result = new Map<string, string>();

  for (const domainId of domainIds) {
    result.set(domainId, monthlyPolicyLabel(scans.get(domainId) ?? null, reports.get(domainId) ?? null));
  }

  return result;
}

interface ScanPolicyRow {
  domainId: string;
  result: Prisma.JsonValue | null;
}

interface ReportPolicyRow {
  domainId: string;
  policyP: string | null;
}

interface DomainReportRow {
  domainId: string;
  reports: bigint;
  organisations: bigint;
}

interface DomainMessageRow {
  domainId: string;
  messages: bigint;
  dmarcPass: bigint;
  spfPass: bigint;
  dkimPass: bigint;
}

interface SourceRow {
  sourceIp: string;
  senderDomain: string | null;
  failed: bigint;
  total: bigint;
}

interface FactsInput {
  client: ClientForReport;
  period: MonthlyPeriod;
  reference: string;
  issuedAt: Date;
}

/**
 * Gathers one client's month.
 *
 * The report is client-level evidence, so every query is joined back through
 * the client and its workspace rather than trusting a list of ids assembled
 * earlier. The SQL aggregates count messages at the database instead of
 * loading a month of report records into memory; only the top ten failing
 * sources and the first 500 domain rows leave it.
 */
export async function collectMonthlyFacts(input: FactsInput): Promise<MonthlyFacts> {
  const { client, period, reference, issuedAt } = input;
  const { start, end } = period;

  const [domains, domainCount] = await Promise.all([
    prisma.domain.findMany({
      where: { clientId: client.id, client: { organizationId: client.organizationId } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: maximumDomainsInDocument,
    }),
    prisma.domain.count({
      where: { clientId: client.id, client: { organizationId: client.organizationId } },
    }),
  ]);

  const domainIds = (
    await prisma.domain.findMany({
      where: { clientId: client.id, client: { organizationId: client.organizationId } },
      select: { id: true },
    })
  ).map((domain) => domain.id);

  const [domainReports, domainMessages, sources, scansAtStart, scansAtEnd, reportsAtStart, reportsAtEnd, changeRows, changeCount, forensicCount, alertsOpened, alertsResolved] =
    await Promise.all([
      prisma.$queryRaw<DomainReportRow[]>`
        SELECT r."domainId" AS "domainId",
               COUNT(*)::bigint AS "reports",
               COUNT(DISTINCT NULLIF(r."reportingOrganization", ''))::bigint AS "organisations"
        FROM "dmarc_report" r
        JOIN "domain" d ON d.id = r."domainId"
        JOIN "client" c ON c.id = d."clientId"
        WHERE c.id = ${client.id} AND c."organizationId" = ${client.organizationId}
          AND r."dateRangeBegin" >= ${start} AND r."dateRangeBegin" < ${end}
        GROUP BY r."domainId"
      `,
      prisma.$queryRaw<DomainMessageRow[]>`
        SELECT r."domainId" AS "domainId",
               COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages",
               COALESCE(SUM(CASE WHEN lower(rec."dkimResult") = 'pass' OR lower(rec."spfResult") = 'pass' THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "dmarcPass",
               COALESCE(SUM(CASE WHEN lower(rec."spfResult") = 'pass' THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "spfPass",
               COALESCE(SUM(CASE WHEN lower(rec."dkimResult") = 'pass' THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "dkimPass"
        FROM "dmarc_report_record" rec
        JOIN "dmarc_report" r ON r.id = rec."reportId"
        JOIN "domain" d ON d.id = r."domainId"
        JOIN "client" c ON c.id = d."clientId"
        WHERE c.id = ${client.id} AND c."organizationId" = ${client.organizationId}
          AND r."dateRangeBegin" >= ${start} AND r."dateRangeBegin" < ${end}
        GROUP BY r."domainId"
      `,
      prisma.$queryRaw<SourceRow[]>`
        SELECT rec."sourceIp" AS "sourceIp",
               MAX(COALESCE(NULLIF(rec."senderDomain", ''), NULLIF(rec."headerFrom", ''))) AS "senderDomain",
               SUM(CASE WHEN COALESCE(lower(rec."dkimResult"), '') <> 'pass'
                          AND COALESCE(lower(rec."spfResult"), '') <> 'pass'
                        THEN rec."messageCount" ELSE 0 END)::bigint AS "failed",
               SUM(rec."messageCount")::bigint AS "total"
        FROM "dmarc_report_record" rec
        JOIN "dmarc_report" r ON r.id = rec."reportId"
        JOIN "domain" d ON d.id = r."domainId"
        JOIN "client" c ON c.id = d."clientId"
        WHERE c.id = ${client.id} AND c."organizationId" = ${client.organizationId}
          AND r."dateRangeBegin" >= ${start} AND r."dateRangeBegin" < ${end}
        GROUP BY rec."sourceIp"
        HAVING SUM(CASE WHEN COALESCE(lower(rec."dkimResult"), '') <> 'pass'
                          AND COALESCE(lower(rec."spfResult"), '') <> 'pass'
                        THEN rec."messageCount" ELSE 0 END) > 0
        ORDER BY "failed" DESC, "total" DESC, rec."sourceIp" ASC
        LIMIT 10
      `,
      prisma.$queryRaw<ScanPolicyRow[]>`
        SELECT d.id AS "domainId", latest.result AS result
        FROM "domain" d
        JOIN "client" c ON c.id = d."clientId"
        LEFT JOIN LATERAL (
          SELECT s.result
          FROM "scan" s
          WHERE s."domainId" = d.id
            AND s."status" = 'COMPLETED'
            AND s."completedAt" < ${start}
          ORDER BY s."completedAt" DESC, s."startedAt" DESC, s.id DESC
          LIMIT 1
        ) latest ON true
        WHERE c.id = ${client.id} AND c."organizationId" = ${client.organizationId}
      `,
      prisma.$queryRaw<ScanPolicyRow[]>`
        SELECT d.id AS "domainId", latest.result AS result
        FROM "domain" d
        JOIN "client" c ON c.id = d."clientId"
        LEFT JOIN LATERAL (
          SELECT s.result
          FROM "scan" s
          WHERE s."domainId" = d.id
            AND s."status" = 'COMPLETED'
            AND s."completedAt" < ${end}
          ORDER BY s."completedAt" DESC, s."startedAt" DESC, s.id DESC
          LIMIT 1
        ) latest ON true
        WHERE c.id = ${client.id} AND c."organizationId" = ${client.organizationId}
      `,
      // The earliest report of the month stands in for the policy at its start.
      // Using the newest one for both ends made a domain with no scans show no
      // movement even when its reports went from p=none to p=reject.
      prisma.$queryRaw<ReportPolicyRow[]>`
        SELECT DISTINCT ON (r."domainId") r."domainId" AS "domainId", r."policyP" AS "policyP"
        FROM "dmarc_report" r
        JOIN "domain" d ON d.id = r."domainId"
        JOIN "client" c ON c.id = d."clientId"
        WHERE c.id = ${client.id} AND c."organizationId" = ${client.organizationId}
          AND r."dateRangeBegin" >= ${start} AND r."dateRangeBegin" < ${end}
          AND r."policyP" IS NOT NULL
        ORDER BY r."domainId", r."dateRangeBegin" ASC, r.id ASC
      `,
      prisma.$queryRaw<ReportPolicyRow[]>`
        SELECT DISTINCT ON (r."domainId") r."domainId" AS "domainId", r."policyP" AS "policyP"
        FROM "dmarc_report" r
        JOIN "domain" d ON d.id = r."domainId"
        JOIN "client" c ON c.id = d."clientId"
        WHERE c.id = ${client.id} AND c."organizationId" = ${client.organizationId}
          AND r."dateRangeBegin" >= ${start} AND r."dateRangeBegin" < ${end}
          AND r."policyP" IS NOT NULL
        ORDER BY r."domainId", r."dateRangeBegin" DESC, r.id DESC
      `,
      prisma.dnsChange.findMany({
        where: {
          domain: { clientId: client.id, client: { organizationId: client.organizationId } },
          severity: { in: ['WARNING', 'CRITICAL'] },
          detectedAt: { gte: start, lt: end },
        },
        select: {
          summary: true,
          detectedAt: true,
          domain: { select: { name: true } },
        },
        orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
        take: maximumChangesInDocument,
      }),
      prisma.dnsChange.count({
        where: {
          domain: { clientId: client.id, client: { organizationId: client.organizationId } },
          severity: { in: ['WARNING', 'CRITICAL'] },
          detectedAt: { gte: start, lt: end },
        },
      }),
      prisma.dmarcForensicReport.count({
        where: {
          receivedAt: { gte: start, lt: end },
          domain: { clientId: client.id, client: { organizationId: client.organizationId } },
        },
      }),
      prisma.alertEvent.count({
        where: {
          triggeredAt: { gte: start, lt: end },
          domain: { clientId: client.id, client: { organizationId: client.organizationId } },
        },
      }),
      prisma.alertEvent.count({
        where: {
          resolvedAt: { gte: start, lt: end },
          domain: { clientId: client.id, client: { organizationId: client.organizationId } },
        },
      }),
    ]);

  const reportByDomain = new Map(domainReports.map((row) => [row.domainId, row]));
  const messagesByDomain = new Map(domainMessages.map((row) => [row.domainId, row]));
  const endPolicies = policyAtPeriod(scansAtEnd, reportsAtEnd, domainIds);
  const startPolicies = policyAtPeriod(scansAtStart, reportsAtStart, domainIds);

  const domainFacts: MonthlyDomainFacts[] = domains.map((domain) => {
    const report = reportByDomain.get(domain.id);
    const messages = messagesByDomain.get(domain.id);
    return {
      name: domain.name,
      policy: endPolicies.get(domain.id) ?? 'not known',
      messages: toNumber(messages?.messages),
      dmarcPass: toNumber(messages?.dmarcPass),
      spfPass: toNumber(messages?.spfPass),
      dkimPass: toNumber(messages?.dkimPass),
      reports: toNumber(report?.reports),
      organisations: toNumber(report?.organisations),
    };
  });

  const totalReports = domainReports.reduce((total, row) => total + toNumber(row.reports), 0);
  const messages = domainMessages.reduce((total, row) => total + toNumber(row.messages), 0);
  const dmarcPass = domainMessages.reduce((total, row) => total + toNumber(row.dmarcPass), 0);
  const spfPass = domainMessages.reduce((total, row) => total + toNumber(row.spfPass), 0);
  const dkimPass = domainMessages.reduce((total, row) => total + toNumber(row.dkimPass), 0);

  const policyDistribution = Object.fromEntries(
    ['none', 'quarantine', 'reject', 'testing', 'no record', 'not known'].map((key) => [key, 0]),
  ) as Record<string, number>;
  for (const domainId of domainIds) {
    const policy = endPolicies.get(domainId) ?? 'not known';
    policyDistribution[policy] = (policyDistribution[policy] ?? 0) + 1;
  }

  let policyMoved = 0;
  for (const domainId of domainIds) {
    if ((startPolicies.get(domainId) ?? 'not known') !== (endPolicies.get(domainId) ?? 'not known')) {
      policyMoved += 1;
    }
  }

  const domainsWithoutReports = domainIds.filter((domainId) => toNumber(reportByDomain.get(domainId)?.reports) === 0).length;
  const changes: MonthlyChangeFacts[] = changeRows.map((row) => ({
    domainName: row.domain.name,
    summary: row.summary,
    detectedAt: row.detectedAt,
  }));

  const sourceIps = sources.map((row) => normaliseIpAddress(row.sourceIp) ?? row.sourceIp);
  const [sourceRecords, sourceIntelRows] = await Promise.all([
    sourceIps.length
      ? prisma.dmarcReportRecord.findMany({
          where: {
            sourceIp: { in: sourceIps },
            report: {
              domain: { clientId: client.id, client: { organizationId: client.organizationId } },
              dateRangeBegin: { gte: start, lt: end },
            },
          },
          select: {
            sourceIp: true,
            messageCount: true,
            authResults: { select: { type: true, domain: true, result: true } },
          },
          take: 5_000,
        })
      : [],
    sourceIps.length
      ? prisma.sourceIpIntel.findMany({
          where: { ip: { in: sourceIps } },
          select: { ip: true, ptr: true, ptrConfirmed: true, asn: true, asnName: true },
        })
      : [],
  ]);
  const signalsByIp = new Map<string, Map<string, AuthSignal>>();
  for (const record of sourceRecords) {
    const ip = normaliseIpAddress(record.sourceIp) ?? record.sourceIp;
    const signals = signalsByIp.get(ip) ?? new Map<string, AuthSignal>();
    for (const auth of record.authResults) {
      const key = `${auth.type}|${auth.domain ?? ''}|${auth.result}`;
      const signal = signals.get(key) ?? {
        type: auth.type,
        domain: auth.domain,
        result: auth.result,
        messageCount: 0,
      };
      signal.messageCount += record.messageCount;
      signals.set(key, signal);
    }
    signalsByIp.set(ip, signals);
  }
  const intel = new Map<string, CachedIntel>(
    sourceIntelRows.map((row) => [
      row.ip,
      { ip: row.ip, ptr: row.ptr, ptrConfirmed: row.ptrConfirmed, asn: row.asn, asnName: row.asnName },
    ]),
  );
  const sourceFacts: MonthlySourceFacts[] = sources.map((row, index) => {
    const ip = sourceIps[index]!;
    const attributed = attributeSourceIp({
      reportedDomain: '',
      ip,
      messages: toNumber(row.total),
      signals: [...(signalsByIp.get(ip)?.values() ?? [])],
      intel: intel.get(ip) ?? null,
    });
    return {
      sourceIp: row.sourceIp,
      senderDomain: row.senderDomain,
      failedMessages: toNumber(row.failed),
      totalMessages: toNumber(row.total),
      service:
        attributed.service && (attributed.confidence === 'confirmed' || attributed.confidence === 'likely')
          ? attributed.service.name
          : null,
    };
  });

  return {
    clientName: client.name,
    agencyName: client.organization.name,
    period,
    reference,
    issuedAt,
    domains: domainFacts,
    domainCount,
    totalReports,
    messages,
    dmarcPass,
    spfPass,
    dkimPass,
    policyDistribution,
    policyMoved,
    domainsWithoutReports,
    changes,
    changeCount,
    sources: sourceFacts,
    forensicCount,
    alertsOpened,
    alertsResolved,
  };
}

function reportFileExpiry(period: MonthlyPeriod): Date {
  return new Date(period.end.getTime() + reportRetentionDays() * 24 * 60 * 60 * 1000);
}

export function normaliseRecipients(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const email = value.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new MonthlyReportError(`"${email}" is not a usable email address.`, 'INVALID_RECIPIENT', 400);
    }
    seen.add(email);
    result.push(email);
  }
  if (result.length > 20) {
    throw new MonthlyReportError('A schedule can email at most 20 recipients.', 'TOO_MANY_RECIPIENTS', 400);
  }
  return result;
}

interface LinkWithToken {
  recipientEmail: string;
  token: string;
  expiresAt: Date;
}

async function createLinks(
  packId: string,
  recipients: readonly string[],
  now: Date,
  fileExpiresAt: Date,
): Promise<LinkWithToken[]> {
  const emails = normaliseRecipients(recipients);
  const expiresAt = new Date(Math.min(now.getTime() + monthlyReportLinkDays * 24 * 60 * 60 * 1000, fileExpiresAt.getTime()));
  const links: LinkWithToken[] = [];

  for (const recipientEmail of emails) {
    const token = randomBytes(32).toString('base64url');
    await prisma.monthlyReportLink.create({
      data: {
        packId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        recipientEmail,
        expiresAt,
      },
    });
    links.push({ recipientEmail, token, expiresAt });
  }

  return links;
}

async function reportBranding(organizationId: string): Promise<{
  branding: MonthlyReportBranding;
  verifyBase: string;
  logo: ReportLogo | null;
}> {
  const resolved = await resolveBranding(organizationId);
  const verifyBase =
    resolved.branded && resolved.customDomain
      ? `https://${resolved.customDomain}`
      : env.APP_URL.replace(/\/$/, '');
  const logo = resolved.branded ? await loadMonthlyReportLogo(resolved.logoUrl) : null;

  return {
    branding: {
      branded: resolved.branded,
      workspaceName: resolved.workspaceName,
      primaryColor: resolved.primaryColor,
      logo: logo?.bytes ?? null,
      verifyBase,
    },
    verifyBase,
    logo,
  };
}

export interface IssuedMonthlyReport {
  id: string;
  reference: string;
  period: MonthlyPeriod;
  issuedAt: Date;
  hash: string;
  byteSize: number;
  pageCount: number;
  expiresAt: Date;
  supersededPrevious: boolean;
  buffer: Buffer;
  links: LinkWithToken[];
  verifyBase: string;
  filename: string;
  summary: { messages: number; dmarcPass: number; domainsAtReject: number };
}

/**
 * Issues one monthly report and stores its bytes.
 *
 * The document is rendered before the transaction, but its `CreationDate` is
 * the issue time passed in, and that same time is written to `createdAt`. A
 * later identical render with the same reference and time therefore produces
 * the same bytes and the same hash.
 */
export async function issueMonthlyReport(input: {
  clientId: string;
  organizationId: string;
  period: string;
  actorUserId?: string | null;
  now?: Date;
  recipients?: readonly string[];
}): Promise<IssuedMonthlyReport> {
  const now = input.now ?? new Date();
  const client = await loadClient(input.clientId, input.organizationId);
  const period = parseMonthlyPeriod(input.period, now, client.createdAt);
  const reference = monthlyReportReference(client.name, period);
  const facts = await collectMonthlyFacts({ client, period, reference, issuedAt: now });
  const { branding, verifyBase } = await reportBranding(input.organizationId);

  const rendered = await withPdfSlot(() => renderMonthlyReportPdf(facts, branding));
  if (rendered.buffer.length > maxMonthlyReportBytes) {
    throw new MonthlyReportError(
      'The report is larger than the 4 MB storage limit. Nothing was issued; contact support if this recurs.',
      'REPORT_TOO_LARGE',
      413,
    );
  }

  const hash = createHash('sha256').update(rendered.buffer).digest('hex');
  const expiresAt = reportFileExpiry(period);

  const existing = await prisma.compliancePack.findFirst({
    where: { pdfHash: hash, organizationId: input.organizationId, scope: reportScope },
    select: { id: true, reference: true, createdAt: true, file: { select: { expiresAt: true } } },
  });

  if (existing) {
    const links = input.recipients?.length
      ? await createLinks(existing.id, input.recipients, now, existing.file?.expiresAt ?? expiresAt)
      : [];
    return {
      id: existing.id,
      reference: existing.reference,
      period,
      issuedAt: existing.createdAt,
      hash,
      byteSize: rendered.buffer.length,
      pageCount: rendered.pageCount,
      expiresAt: existing.file?.expiresAt ?? expiresAt,
      supersededPrevious: false,
      buffer: rendered.buffer,
      links,
      verifyBase,
      filename: monthlyReportFilename(client.name, period),
      summary: {
        messages: facts.messages,
        dmarcPass: facts.dmarcPass,
        domainsAtReject: facts.policyDistribution.reject ?? 0,
      },
    };
  }

  const created = await prisma.$transaction(async (tx) => {
    const previous = await tx.compliancePack.updateMany({
      where: {
        clientId: client.id,
        scope: reportScope,
        periodStart: period.start,
        supersededAt: null,
      },
      data: { supersededAt: now },
    });

    const row = await tx.compliancePack.create({
      data: {
        organizationId: input.organizationId,
        clientId: client.id,
        scope: reportScope,
        documentVersion: monthlyDocumentVersion,
        periodStart: period.start,
        periodEnd: period.end,
        asOf: now,
        createdAt: now,
        pdfHash: hash,
        reference,
        byteSize: rendered.buffer.length,
        pageCount: rendered.pageCount,
        generatedById: input.actorUserId ?? null,
        file: {
          create: {
            bytes: rendered.buffer,
            contentType: 'application/pdf',
            expiresAt,
          },
        },
      },
      select: { id: true, reference: true },
    });

    return { row, supersededPrevious: previous.count > 0 };
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'MONTHLY_REPORT_ISSUED',
    targetType: 'monthly_report',
    targetId: created.row.id,
    detail: {
      clientId: client.id,
      period: period.key,
      reference,
      hash,
      byteSize: rendered.buffer.length,
      pageCount: rendered.pageCount,
    },
  });

  const links = input.recipients?.length
    ? await createLinks(created.row.id, input.recipients, now, expiresAt)
    : [];

  return {
    id: created.row.id,
    reference,
    period,
    issuedAt: now,
    hash,
    byteSize: rendered.buffer.length,
    pageCount: rendered.pageCount,
    expiresAt,
    supersededPrevious: created.supersededPrevious,
    buffer: rendered.buffer,
    links,
    verifyBase,
    filename: monthlyReportFilename(client.name, period),
    summary: {
      messages: facts.messages,
      dmarcPass: facts.dmarcPass,
      domainsAtReject: facts.policyDistribution.reject ?? 0,
    },
  };
}

export interface MonthlyReportListRow {
  id: string;
  reference: string;
  period: string | null;
  sha256: string;
  byteSize: number;
  pageCount: number;
  issuedAt: string;
  superseded: boolean;
  downloadable: boolean;
}

export async function listMonthlyReports(
  organizationId: string,
  clientId: string,
  options: { includeSuperseded?: boolean; now?: Date } = {},
): Promise<MonthlyReportListRow[]> {
  const now = options.now ?? new Date();
  const rows = await prisma.compliancePack.findMany({
    where: {
      organizationId,
      clientId,
      scope: reportScope,
      client: { organizationId },
      ...(options.includeSuperseded === false ? { supersededAt: null } : {}),
    },
    select: {
      id: true,
      reference: true,
      periodStart: true,
      pdfHash: true,
      byteSize: true,
      pageCount: true,
      createdAt: true,
      supersededAt: true,
      file: { select: { expiresAt: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 24,
  });

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    period: row.periodStart ? row.periodStart.toISOString().slice(0, 7) : null,
    sha256: row.pdfHash,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    issuedAt: row.createdAt.toISOString(),
    superseded: row.supersededAt !== null,
    downloadable: Boolean(row.file && row.file.expiresAt.getTime() > now.getTime()),
  }));
}

async function loadReportForDownload(
  organizationId: string,
  clientId: string,
  reportId: string,
  currentOnly = false,
) {
  const row = await prisma.compliancePack.findFirst({
    where: {
      id: reportId,
      organizationId,
      clientId,
      scope: reportScope,
      client: { organizationId },
      ...(currentOnly ? { supersededAt: null } : {}),
    },
    select: {
      id: true,
      reference: true,
      pdfHash: true,
      periodStart: true,
      createdAt: true,
      client: { select: { name: true } },
      file: { select: { bytes: true, expiresAt: true } },
    },
  });

  if (!row) {
    throw new MonthlyReportError('That report is not in this workspace.', 'REPORT_NOT_FOUND', 404);
  }
  if (!row.file || row.file.expiresAt.getTime() <= Date.now()) {
    throw new MonthlyReportError(
      'That report is no longer held. Its fingerprint can still be verified.',
      'REPORT_EXPIRED',
      410,
    );
  }

  return row;
}

function verifyStoredBytes(row: { pdfHash: string; file: { bytes: Uint8Array } | null }) {
  if (!row.file) {
    throw new MonthlyReportError('That report is no longer held.', 'REPORT_EXPIRED', 410);
  }
  const digest = createHash('sha256').update(row.file.bytes).digest('hex');
  if (digest !== row.pdfHash) {
    throw new MonthlyReportError(
      'The stored report does not match its published fingerprint. Nothing was sent.',
      'REPORT_CORRUPT',
      500,
    );
  }
}

export async function downloadMonthlyReport(input: {
  organizationId: string;
  clientId: string;
  reportId: string;
  actorUserId?: string | null;
  currentOnly?: boolean;
}): Promise<{ buffer: Buffer; reference: string; filename: string; hash: string }> {
  const row = await loadReportForDownload(
    input.organizationId,
    input.clientId,
    input.reportId,
    input.currentOnly === true,
  );
  verifyStoredBytes(row);
  const period = periodFromKey(row.periodStart?.toISOString().slice(0, 7) ?? '');

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'MONTHLY_REPORT_DOWNLOADED',
    targetType: 'monthly_report',
    targetId: row.id,
    detail: { clientId: input.clientId, period: period.key, reference: row.reference },
  });

  return {
    buffer: Buffer.from(row.file!.bytes),
    reference: row.reference,
    filename: monthlyReportFilename(row.client.name, period),
    hash: row.pdfHash,
  };
}

export class InvalidReportLinkError extends MonthlyReportError {
  constructor() {
    super('That download link is not available.', 'REPORT_LINK_NOT_FOUND', 404);
    this.name = 'InvalidReportLinkError';
  }
}

export async function downloadMonthlyReportByToken(
  rawToken: string,
  now = new Date(),
): Promise<{ buffer: Buffer; reference: string; filename: string; hash: string }> {
  const token = rawToken.trim();
  if (!token || token.length > 256) {
    throw new InvalidReportLinkError();
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const link = await prisma.monthlyReportLink.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      pack: {
        select: {
          id: true,
          organizationId: true,
          reference: true,
          pdfHash: true,
          periodStart: true,
          scope: true,
          client: { select: { name: true } },
          file: { select: { bytes: true, expiresAt: true } },
        },
      },
    },
  });

  if (
    !link ||
    link.expiresAt.getTime() <= now.getTime() ||
    link.pack.scope !== reportScope ||
    !link.pack.file ||
    link.pack.file.expiresAt.getTime() <= now.getTime()
  ) {
    throw new InvalidReportLinkError();
  }

  verifyStoredBytes({ pdfHash: link.pack.pdfHash, file: link.pack.file });
  const period = periodFromKey(link.pack.periodStart?.toISOString().slice(0, 7) ?? '');

  await prisma.monthlyReportLink.update({
    where: { id: link.id },
    data: { useCount: { increment: 1 }, lastUsedAt: now },
  });

  await recordAuditEvent({
    organizationId: link.pack.organizationId,
    action: 'MONTHLY_REPORT_DOWNLOADED',
    targetType: 'monthly_report_link',
    targetId: link.id,
    detail: { reportId: link.pack.id, period: period.key, reference: link.pack.reference },
  });

  return {
    buffer: Buffer.from(link.pack.file.bytes),
    reference: link.pack.reference,
    filename: monthlyReportFilename(link.pack.client.name, period),
    hash: link.pack.pdfHash,
  };
}

export { packScope, reportScope };
