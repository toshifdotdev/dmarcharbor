import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { hasAggregateReporting, readDmarcRecord } from '../scanner/dmarc-tags.js';
import { passesDmarc } from './alignment.service.js';
import { domainRef } from './domain-ref.js';
import { buildSenderBreakdown, type SenderBreakdownRow } from './sender-breakdown.service.js';
import { attributeSourceIp, type AuthSignal, type CachedIntel, type SenderConfidence, type SenderService } from './senders/attribution.js';
import { normaliseIpAddress } from './senders/ip-intel.service.js';

const maxScannedRecords = 5_000;
const defaultTrendDays = 30;
const maximumTrendDays = 365;
/** How far back the policy history reads. Older reports are usually past retention anyway. */
const policyHistoryDays = 730;
const spikeStandardDeviations = 2;

export interface SourceAttribution {
  sourceIp: string;
  totalMessages: number;
  /** Messages that failed DMARC: both aligned checks failed. */
  failedMessages: number;
  /** Messages that passed DMARC but failed one aligned check. */
  partiallyAlignedMessages: number;
  forensicMessages: number;
  reportCount: number;
  lastSeenAt: string | null;
  topSendingDomain: string | null;
  risk: 'high' | 'medium' | 'low';
  service: SenderService | null;
  confidence: SenderConfidence;
}

export interface TrendPoint {
  date: string;
  reportsReceived: number;
  messagesObserved: number;
  /** DMARC failures: both aligned checks failed. */
  failedMessages: number;
  /** Messages whose aligned SPF passed, and whose aligned DKIM passed, that day. */
  spfPassMessages: number;
  dkimPassMessages: number;
}

/** One receiver that sends this domain reports, e.g. google.com or Microsoft. */
export interface ReporterShare {
  organization: string;
  reports: number;
  messages: number;
}

/** A change in the policy receivers saw published, from the reports themselves. */
export interface PolicyStep {
  /** UTC day the first report showing this policy was received. */
  date: string;
  policy: string;
}

export interface TrendSpike {
  date: string;
  messagesObserved: number;
  averageMessages: number;
  multiple: number;
}

export interface DomainInsights {
  domain: { id: string; name: string; status: string; score: number | null };
  reporting: {
    publishedPolicy: string | null;
    aggregateConfigured: boolean;
    forensicConfigured: boolean;
    collectionEnabled: boolean;
    identityRetentionEnabled: boolean;
  };
  senders: SenderBreakdownRow[];
  aggregate: {
    reportCount: number;
    recordCount: number;
    messageCount: number;
    /** DMARC failures: messages where both aligned checks failed. */
    failedMessages: number;
    dmarcPassRate: number | null;
    /** Passed DMARC but failed one aligned check. */
    partiallyAlignedMessages: number;
    spfPassRate: number | null;
    dkimPassRate: number | null;
    lastReportAt: string | null;
    messageWindow: { begin: string | null; end: string | null };
  };
  forensic: {
    count: number;
    rejectedMessages: number;
    affectedRecipients: number;
    retainedIdentities: number;
    lastReportAt: string | null;
  };
  sources: SourceAttribution[];
  trends: { days: number; points: TrendPoint[]; spikes: TrendSpike[] };
  /** Who sends the reports, by messages reported, largest first (top 8). */
  reporters: ReporterShare[];
  /** How many distinct receivers reported, including those beyond the top 8. */
  reporterCount: number;
  /** What receivers did with the mail, by the disposition each record reports. */
  dispositions: { none: number; quarantine: number; reject: number };
  /** Each change in the published policy as reporters saw it, oldest first. */
  policyHistory: PolicyStep[];
}

function isPass(value: string | null): boolean {
  return (value ?? '').trim().toLowerCase() === 'pass';
}

function riskFor(failed: number, total: number): 'high' | 'medium' | 'low' {
  if (failed === 0) {
    return 'low';
  }

  const share = total > 0 ? failed / total : 1;
  if (share >= 0.5 || failed >= 100) {
    return 'high';
  }

  return share >= 0.1 ? 'medium' : 'low';
}

function roundPercent(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 100;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function emptyMap(): Map<string, SourceAttribution> {
  return new Map();
}

function touchSource(
  sources: Map<string, SourceAttribution>,
  sourceIp: string,
  apply: (entry: SourceAttribution) => void,
): void {
  const existing = sources.get(sourceIp) ?? {
    sourceIp,
    totalMessages: 0,
    failedMessages: 0,
    partiallyAlignedMessages: 0,
    forensicMessages: 0,
    reportCount: 0,
    lastSeenAt: null,
    topSendingDomain: null,
    risk: 'low' as const,
    service: null,
    confidence: 'unknown' as const,
  };

  apply(existing);
  existing.risk = riskFor(existing.failedMessages, existing.totalMessages + existing.forensicMessages);
  sources.set(sourceIp, existing);
}

function latestIso(current: string | null, candidate: Date | null): string | null {
  if (!candidate) {
    return current;
  }

  const value = candidate.toISOString();
  return !current || value > current ? value : current;
}

export async function getDomainInsights(
  organizationId: string,
  domainId: string,
  trendDays = defaultTrendDays,
): Promise<DomainInsights | null> {
    const domain = await prisma.domain.findFirst({
      where: {
        client: { organizationId },
        ...domainRef(domainId),
      },
      select: {

      id: true,
      name: true,
      status: true,
      score: true,
      dmarcRecord: true,
      dmarcPolicy: true,
      collectForensicReports: true,
      retainForensicPii: true,
    },
  });

  if (!domain) {
    return null;
  }

  const [reports, forensics, senders] = await Promise.all([
    prisma.dmarcReport.findMany({
      where: { domainId: domain.id },
      select: {
        receivedAt: true,
        records: {
          select: {
            sourceIp: true,
            messageCount: true,
            dkimResult: true,
            spfResult: true,
            headerFrom: true,
            authResults: { select: { type: true, domain: true, result: true } },
          },
          take: maxScannedRecords,
        },
      },
      orderBy: { receivedAt: 'desc' },
      take: 500,
    }),
    prisma.dmarcForensicReport.findMany({
      where: { domainId: domain.id },
      select: {
        sourceIp: true,
        disposition: true,
        arrivedAt: true,
        receivedAt: true,
        piiRetained: true,
        recipientPseudonyms: true,
      },
      take: maxScannedRecords,
    }),
    buildSenderBreakdown(organizationId, domainId),
  ]);

  // The domain's totals, its receivers and what they did with the mail are
  // counted in SQL over every report held, so they agree with the daily chart
  // however busy the domain is. The scan above (the latest 500 reports) feeds
  // only the per-source attribution, which needs each record's auth results.
  const [totals, reporterRows, dispositionRows] = await Promise.all([
    aggregateTotals(domain.id),
    reporterShares(domain.id),
    dispositionCounts(domain.id),
  ]);
  const recordCount = totals.records;
  const messageCount = totals.messages;
  const failedMessages = totals.failed;
  const partiallyAlignedMessages = totals.partial;
  const spfPass = totals.spf;
  const dkimPass = totals.dkim;
  const lastReportAt = totals.lastReportAt;
  const windowBegin = totals.windowBegin;
  const windowEnd = totals.windowEnd;
  const dispositions = { none: 0, quarantine: 0, reject: 0 };
  for (const row of dispositionRows) {
    if (row.disposition === 'reject') dispositions.reject += Number(row.messages);
    else if (row.disposition === 'quarantine') dispositions.quarantine += Number(row.messages);
    else dispositions.none += Number(row.messages);
  }

  const sources = emptyMap();
  const ipSignals = new Map<string, Map<string, AuthSignal>>();

  for (const report of reports) {
    for (const record of report.records) {
      const dmarcFailed = !passesDmarc(record);
      const partiallyAligned = !dmarcFailed && (!isPass(record.dkimResult) || !isPass(record.spfResult));

      const sendingDomain =
        record.authResults.find((result) => result.domain)?.domain ?? record.headerFrom ?? null;
      const sourceIp = normaliseIpAddress(record.sourceIp) ?? record.sourceIp;

      const signals = ipSignals.get(sourceIp) ?? new Map<string, AuthSignal>();
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
      ipSignals.set(sourceIp, signals);

      touchSource(sources, sourceIp, (entry) => {
        entry.totalMessages += record.messageCount;
        entry.reportCount += 1;
        entry.lastSeenAt = latestIso(entry.lastSeenAt, report.receivedAt);
        if (dmarcFailed) {
          entry.failedMessages += record.messageCount;
        } else if (partiallyAligned) {
          entry.partiallyAlignedMessages += record.messageCount;
        }
        if (sendingDomain && !entry.topSendingDomain) {
          entry.topSendingDomain = sendingDomain;
        }
      });
    }
  }

  const recipientPseudonyms = new Set<string>();
  let rejectedMessages = 0;
  let retainedIdentities = 0;
  let lastForensicAt: string | null = null;

  for (const forensic of forensics) {
    lastForensicAt = latestIso(lastForensicAt, forensic.arrivedAt ?? forensic.receivedAt);
    if (forensic.disposition === 'reject' || forensic.disposition === 'quarantine') {
      rejectedMessages += 1;
    }
    if (forensic.piiRetained) {
      retainedIdentities += 1;
    }
    if (Array.isArray(forensic.recipientPseudonyms)) {
      for (const value of forensic.recipientPseudonyms) {
        if (typeof value === 'string' && value) {
          recipientPseudonyms.add(value);
        }
      }
    }

    const forensicIp = normaliseIpAddress(forensic.sourceIp) ?? forensic.sourceIp;
    touchSource(sources, forensicIp, (entry) => {
      entry.forensicMessages += 1;
      entry.lastSeenAt = latestIso(entry.lastSeenAt, forensic.arrivedAt ?? forensic.receivedAt);
    });
  }

  const sourceIps = [...sources.keys()];
  const intelRows = sourceIps.length
    ? await prisma.sourceIpIntel.findMany({
        where: { ip: { in: sourceIps } },
        select: { ip: true, ptr: true, ptrConfirmed: true, asn: true, asnName: true },
      })
    : [];
  const intel = new Map<string, CachedIntel>(
    intelRows.map((row) => [
      row.ip,
      { ip: row.ip, ptr: row.ptr, ptrConfirmed: row.ptrConfirmed, asn: row.asn, asnName: row.asnName },
    ]),
  );

  for (const source of sources.values()) {
    const attributed = attributeSourceIp({
      reportedDomain: domain.name,
      ip: source.sourceIp,
      messages: source.totalMessages,
      signals: [...(ipSignals.get(source.sourceIp)?.values() ?? [])],
      intel: intel.get(source.sourceIp) ?? null,
    });
    source.service = attributed.service;
    source.confidence = attributed.confidence;
  }

  const days = Math.min(Math.max(trendDays, 1), maximumTrendDays);
  // The daily points and the policy history are counted in SQL over the whole
  // window, not from the capped scan above: a busy domain's latest 500 reports
  // can cover less than 30 days, and the charts would then draw real days as
  // "no report received".
  const [points, policyHistory] = await Promise.all([dailyPoints(domain.id, days), policyHistoryOf(domain.id)]);
  const observed = points.map((point) => point.messagesObserved);
  const average = observed.length ? observed.reduce((total, value) => total + value, 0) / observed.length : 0;
  const deviation = standardDeviation(observed);
  const spikes: TrendSpike[] =
    average > 0 && deviation > 0
      ? points
          .filter((point) => point.messagesObserved > average + spikeStandardDeviations * deviation)
          .map((point) => ({
            date: point.date,
            messagesObserved: point.messagesObserved,
            averageMessages: Math.round(average),
            multiple: Math.round((point.messagesObserved / average) * 100) / 100,
          }))
      : [];

  const tags = readDmarcRecord(domain.dmarcRecord);
  const aggregateConfigured = hasAggregateReporting(tags);
  const forensicConfigured = tags.forensicTargets.length > 0;

  return {
    domain: { id: domain.id, name: domain.name, status: domain.status, score: domain.score },
    reporting: {
      publishedPolicy: domain.dmarcPolicy,
      aggregateConfigured,
      forensicConfigured,
      collectionEnabled: domain.collectForensicReports,
      identityRetentionEnabled: domain.retainForensicPii,
    },
    senders,
    aggregate: {
      reportCount: totals.reports,
      recordCount,
      messageCount,
      failedMessages,
      dmarcPassRate: roundPercent(messageCount ? (messageCount - failedMessages) / messageCount : null),
      partiallyAlignedMessages,
      spfPassRate: roundPercent(messageCount ? spfPass / messageCount : null),
      dkimPassRate: roundPercent(messageCount ? dkimPass / messageCount : null),
      lastReportAt,
      messageWindow: { begin: windowBegin, end: windowEnd },
    },
    forensic: {
      count: forensics.length,
      rejectedMessages,
      affectedRecipients: recipientPseudonyms.size,
      retainedIdentities,
      lastReportAt: lastForensicAt,
    },
    sources: [...sources.values()]
      .sort((left, right) => right.failedMessages - left.failedMessages || right.totalMessages - left.totalMessages)
      .slice(0, 25),
    trends: { days, points, spikes },
    reporters: reporterRows.slice(0, 8).map((row) => ({
      organization: row.organization,
      reports: Number(row.reports),
      messages: Number(row.messages),
    })),
    reporterCount: reporterRows.length,
    dispositions,
    policyHistory,
  };
}

/** passesDmarc() in SQL: DKIM or SPF passed. */
const DKIM_PASS = Prisma.sql`lower(trim(COALESCE(rec."dkimResult", ''))) = 'pass'`;
const SPF_PASS = Prisma.sql`lower(trim(COALESCE(rec."spfResult", ''))) = 'pass'`;

interface TotalsRow {
  reports: bigint;
  records: bigint;
  messages: bigint;
  failed: bigint;
  partial: bigint;
  spf: bigint;
  dkim: bigint;
  lastReceived: Date | null;
  windowBegin: Date | null;
  windowEnd: Date | null;
}

/** The domain's figures over every aggregate report held (retention bounds them). */
async function aggregateTotals(domainId: string) {
  const [row] = await prisma.$queryRaw<TotalsRow[]>`
    SELECT COUNT(DISTINCT r.id)::bigint AS "reports",
           COUNT(rec.id)::bigint AS "records",
           COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages",
           COALESCE(SUM(CASE WHEN rec.id IS NOT NULL AND NOT (${DKIM_PASS}) AND NOT (${SPF_PASS}) THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "failed",
           COALESCE(SUM(CASE WHEN (${DKIM_PASS} OR ${SPF_PASS}) AND NOT (${DKIM_PASS} AND ${SPF_PASS}) THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "partial",
           COALESCE(SUM(CASE WHEN ${SPF_PASS} THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "spf",
           COALESCE(SUM(CASE WHEN ${DKIM_PASS} THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "dkim",
           MAX(r."receivedAt") AS "lastReceived",
           MIN(r."dateRangeBegin") AS "windowBegin",
           MAX(r."dateRangeEnd") AS "windowEnd"
    FROM "dmarc_report" r
    LEFT JOIN "dmarc_report_record" rec ON rec."reportId" = r.id
    WHERE r."domainId" = ${domainId}
      AND r."reportType" = 'AGGREGATE'
  `;
  const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);
  return {
    reports: Number(row?.reports ?? 0),
    records: Number(row?.records ?? 0),
    messages: Number(row?.messages ?? 0),
    failed: Number(row?.failed ?? 0),
    partial: Number(row?.partial ?? 0),
    spf: Number(row?.spf ?? 0),
    dkim: Number(row?.dkim ?? 0),
    lastReportAt: iso(row?.lastReceived),
    windowBegin: iso(row?.windowBegin),
    windowEnd: iso(row?.windowEnd),
  };
}

interface ReporterRow {
  organization: string;
  reports: bigint;
  messages: bigint;
}

/**
 * Every receiver that reported, largest by messages first. The name is the
 * receiver's own, as given; names that differ only in case are one receiver.
 */
async function reporterShares(domainId: string): Promise<ReporterRow[]> {
  return prisma.$queryRaw<ReporterRow[]>`
    SELECT MIN(COALESCE(NULLIF(trim(r."reportingOrganization"), ''), 'Not named')) AS "organization",
           COUNT(DISTINCT r.id)::bigint AS "reports",
           COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages"
    FROM "dmarc_report" r
    LEFT JOIN "dmarc_report_record" rec ON rec."reportId" = r.id
    WHERE r."domainId" = ${domainId}
      AND r."reportType" = 'AGGREGATE'
    GROUP BY lower(COALESCE(NULLIF(trim(r."reportingOrganization"), ''), 'Not named'))
    ORDER BY 3 DESC, 2 DESC, 1
  `;
}

interface DispositionRow {
  disposition: string;
  messages: bigint;
}

async function dispositionCounts(domainId: string): Promise<DispositionRow[]> {
  return prisma.$queryRaw<DispositionRow[]>`
    SELECT lower(trim(COALESCE(rec."disposition", 'none'))) AS "disposition",
           COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages"
    FROM "dmarc_report_record" rec
    JOIN "dmarc_report" r ON r.id = rec."reportId"
    WHERE r."domainId" = ${domainId}
      AND r."reportType" = 'AGGREGATE'
    GROUP BY 1
  `;
}

interface DailyRow {
  day: string;
  reports: bigint;
  messages: bigint;
  failed: bigint;
  spf: bigint;
  dkim: bigint;
}

/**
 * One point per UTC day (by the day the report was received) that had an
 * aggregate report, over the last `days` days. Counted in the database, so the
 * cost does not grow with the number of records held in memory. DMARC passes
 * as passesDmarc() decides it: DKIM or SPF passed.
 */
async function dailyPoints(domainId: string, days: number): Promise<TrendPoint[]> {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(today - (days - 1) * 86_400_000);
  const rows = await prisma.$queryRaw<DailyRow[]>`
    SELECT to_char(r."receivedAt", 'YYYY-MM-DD') AS "day",
           COUNT(DISTINCT r.id)::bigint AS "reports",
           COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages",
           COALESCE(SUM(CASE WHEN lower(trim(COALESCE(rec."dkimResult", ''))) <> 'pass'
                              AND lower(trim(COALESCE(rec."spfResult", ''))) <> 'pass'
                             THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "failed",
           COALESCE(SUM(CASE WHEN lower(trim(COALESCE(rec."spfResult", ''))) = 'pass' THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "spf",
           COALESCE(SUM(CASE WHEN lower(trim(COALESCE(rec."dkimResult", ''))) = 'pass' THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "dkim"
    FROM "dmarc_report" r
    LEFT JOIN "dmarc_report_record" rec ON rec."reportId" = r.id
    WHERE r."domainId" = ${domainId}
      AND r."reportType" = 'AGGREGATE'
      AND r."receivedAt" >= ${since}
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((row) => ({
    date: row.day,
    reportsReceived: Number(row.reports),
    messagesObserved: Number(row.messages),
    failedMessages: Number(row.failed),
    spfPassMessages: Number(row.spf),
    dkimPassMessages: Number(row.dkim),
  }));
}

interface PolicyDayRow {
  day: string;
  policy: string;
  reports: bigint;
}

/**
 * The published policy as reporters saw it, one step per change, oldest first.
 *
 * Each day takes the policy most of that day's reports carried, so a receiver
 * still reporting from a cached DNS record on the day of a change does not
 * draw the policy flapping back and forth. Read in SQL over two years, so a
 * busy domain's history is not cut to its latest 500 reports.
 */
async function policyHistoryOf(domainId: string): Promise<PolicyStep[]> {
  const since = new Date(Date.now() - policyHistoryDays * 86_400_000);
  const rows = await prisma.$queryRaw<PolicyDayRow[]>`
    SELECT to_char(r."receivedAt", 'YYYY-MM-DD') AS "day",
           lower(trim(r."policyP")) AS "policy",
           COUNT(*)::bigint AS "reports"
    FROM "dmarc_report" r
    WHERE r."domainId" = ${domainId}
      AND r."reportType" = 'AGGREGATE'
      AND r."receivedAt" >= ${since}
      AND r."policyP" IS NOT NULL
      AND trim(r."policyP") <> ''
    GROUP BY 1, 2
    ORDER BY 1, 3 DESC, 2
  `;
  const steps: PolicyStep[] = [];
  let lastDay = '';
  for (const row of rows) {
    // Ordered by day, then by report count: the first row of a day is that day's policy.
    if (row.day === lastDay) continue;
    lastDay = row.day;
    if (steps.length > 0 && steps[steps.length - 1]!.policy === row.policy) continue;
    steps.push({ date: row.day, policy: row.policy });
  }
  return steps;
}
