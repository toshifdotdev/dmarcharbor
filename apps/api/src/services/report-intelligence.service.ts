import { prisma } from '../database/prisma.js';
import { hasAggregateReporting, readDmarcRecord } from '../scanner/dmarc-tags.js';
import { domainRef } from './domain-ref.js';
import {
  DKIM_PASS,
  SPF_PASS,
  dailyPointsByDomain,
  emptyTotals,
  policyHistoryByDomain,
  totalsByDomain,
} from './report-aggregates.service.js';
import { buildSenderBreakdown, type SenderBreakdownRow } from './sender-breakdown.service.js';
import { attributeSourceIp, type AuthSignal, type CachedIntel, type SenderConfidence, type SenderService } from './senders/attribution.js';
import { normaliseIpAddress } from './senders/ip-intel.service.js';

/** How many sources the insights list, largest problem first. */
const listedSources = 25;
const defaultTrendDays = 30;
const maximumTrendDays = 365;
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

  // Every figure here is counted in the database over every report held, so a
  // busy domain's totals, sources, receivers and charts agree with each other.
  // Nothing loads raw records into memory any more: the old scan read the
  // latest 500 reports, which a domain with 25 receivers passes in three weeks.
  const [senders, totals, reporterRows, dispositionRows, sourceRows, forensicTotals, forensicByIp] = await Promise.all([
    buildSenderBreakdown(organizationId, domain.id),
    totalsByDomain([domain.id]).then((all) => all.get(domain.id) ?? emptyTotals()),
    reporterShares(domain.id),
    dispositionCounts(domain.id),
    sourceTotals(domain.id),
    forensicSummary(domain.id),
    forensicSources(domain.id),
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
  for (const row of sourceRows) {
    const sourceIp = normaliseIpAddress(row.ip) ?? row.ip;
    touchSource(sources, sourceIp, (entry) => {
      entry.totalMessages += Number(row.messages);
      entry.reportCount += Number(row.reports);
      entry.failedMessages += Number(row.failed);
      entry.partiallyAlignedMessages += Number(row.partial);
      entry.lastSeenAt = latestIso(entry.lastSeenAt, row.lastSeen ? new Date(row.lastSeen) : null);
      entry.topSendingDomain ??= row.headerFrom;
    });
  }
  for (const row of forensicByIp) {
    const sourceIp = normaliseIpAddress(row.ip) ?? row.ip;
    touchSource(sources, sourceIp, (entry) => {
      entry.forensicMessages += Number(row.reports);
      entry.lastSeenAt = latestIso(entry.lastSeenAt, row.lastSeen ? new Date(row.lastSeen) : null);
    });
  }

  // Only the sources that will be listed are attributed: sorted as the list
  // is, then cut. A domain can have thousands of sending addresses.
  const listed = [...sources.values()]
    .sort((left, right) => right.failedMessages - left.failedMessages || right.totalMessages - left.totalMessages)
    .slice(0, listedSources);
  const signalRows = await sourceSignals(
    domain.id,
    sourceRows.map((row) => row.ip).filter((ip) => listed.some((s) => s.sourceIp === (normaliseIpAddress(ip) ?? ip))),
  );
  const ipSignals = new Map<string, Map<string, AuthSignal>>();
  for (const row of signalRows) {
    const sourceIp = normaliseIpAddress(row.ip) ?? row.ip;
    const signals = ipSignals.get(sourceIp) ?? new Map<string, AuthSignal>();
    const key = `${row.type}|${row.domain ?? ''}|${row.result}`;
    const signal = signals.get(key) ?? { type: row.type, domain: row.domain, result: row.result, messageCount: 0 };
    signal.messageCount += Number(row.messages);
    signals.set(key, signal);
    ipSignals.set(sourceIp, signals);
  }
  // The domain the most mail from a source authenticated as names it, ahead of
  // the From header the query fell back on.
  for (const source of listed) {
    const best = [...(ipSignals.get(source.sourceIp)?.values() ?? [])]
      .filter((signal) => signal.domain)
      .sort((a, b) => b.messageCount - a.messageCount)[0];
    if (best?.domain) source.topSendingDomain = best.domain;
  }

  const sourceIps = listed.map((source) => source.sourceIp);
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

  for (const source of listed) {
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
  const [points, policyHistory] = await Promise.all([
    dailyPointsByDomain([domain.id], days).then((all) => all.get(domain.id) ?? []),
    policyHistoryByDomain([domain.id]).then((all) => all.get(domain.id) ?? []),
  ]);
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
    forensic: forensicTotals,
    sources: listed,
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

interface SourceRow {
  ip: string;
  reports: bigint;
  messages: bigint;
  failed: bigint;
  partial: bigint;
  lastSeen: Date | null;
  headerFrom: string | null;
}

/** Each sending address over every aggregate record held. */
async function sourceTotals(domainId: string): Promise<SourceRow[]> {
  return prisma.$queryRaw<SourceRow[]>`
    SELECT rec."sourceIp" AS "ip",
           COUNT(DISTINCT r.id)::bigint AS "reports",
           COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages",
           COALESCE(SUM(CASE WHEN NOT (${DKIM_PASS}) AND NOT (${SPF_PASS}) THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "failed",
           COALESCE(SUM(CASE WHEN (${DKIM_PASS} OR ${SPF_PASS}) AND NOT (${DKIM_PASS} AND ${SPF_PASS}) THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "partial",
           MAX(r."receivedAt") AS "lastSeen",
           mode() WITHIN GROUP (ORDER BY NULLIF(rec."headerFrom", '')) AS "headerFrom"
    FROM "dmarc_report_record" rec
    JOIN "dmarc_report" r ON r.id = rec."reportId"
    WHERE r."domainId" = ${domainId}
      AND r."reportType" = 'AGGREGATE'
    GROUP BY rec."sourceIp"
  `;
}

interface SourceSignalRow {
  ip: string;
  type: string;
  domain: string | null;
  result: string;
  messages: bigint;
}

/** The auth results behind the listed sources, which attribution reads. */
async function sourceSignals(domainId: string, ips: string[]): Promise<SourceSignalRow[]> {
  if (ips.length === 0) return [];
  return prisma.$queryRaw<SourceSignalRow[]>`
    SELECT rec."sourceIp" AS "ip",
           a."type"::text AS "type",
           a."domain" AS "domain",
           a."result" AS "result",
           COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages"
    FROM "dmarc_auth_result" a
    JOIN "dmarc_report_record" rec ON rec.id = a."recordId"
    JOIN "dmarc_report" r ON r.id = rec."reportId"
    WHERE r."domainId" = ${domainId}
      AND r."reportType" = 'AGGREGATE'
      AND rec."sourceIp" = ANY(${ips}::text[])
    GROUP BY 1, 2, 3, 4
  `;
}

interface ForensicSummaryRow {
  count: bigint;
  rejected: bigint;
  retained: bigint;
  lastAt: Date | null;
  recipients: bigint;
}

/** The forensic figures over every report held, not the latest 5,000. */
async function forensicSummary(domainId: string): Promise<DomainInsights['forensic']> {
  const [row] = await prisma.$queryRaw<ForensicSummaryRow[]>`
    SELECT COUNT(*)::bigint AS "count",
           COUNT(*) FILTER (WHERE f."disposition" IN ('reject', 'quarantine'))::bigint AS "rejected",
           COUNT(*) FILTER (WHERE f."piiRetained")::bigint AS "retained",
           MAX(COALESCE(f."arrivedAt", f."receivedAt")) AS "lastAt",
           (SELECT COUNT(DISTINCT v)
              FROM "dmarc_forensic_report" g,
                   jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(g."recipientPseudonyms"::jsonb) = 'array' THEN g."recipientPseudonyms"::jsonb ELSE '[]'::jsonb END
                   ) AS v
             WHERE g."domainId" = ${domainId} AND v <> '')::bigint AS "recipients"
    FROM "dmarc_forensic_report" f
    WHERE f."domainId" = ${domainId}
  `;
  return {
    count: Number(row?.count ?? 0),
    rejectedMessages: Number(row?.rejected ?? 0),
    affectedRecipients: Number(row?.recipients ?? 0),
    retainedIdentities: Number(row?.retained ?? 0),
    lastReportAt: row?.lastAt ? new Date(row.lastAt).toISOString() : null,
  };
}

interface ForensicSourceRow {
  ip: string;
  reports: bigint;
  lastSeen: Date | null;
}

async function forensicSources(domainId: string): Promise<ForensicSourceRow[]> {
  return prisma.$queryRaw<ForensicSourceRow[]>`
    SELECT f."sourceIp" AS "ip",
           COUNT(*)::bigint AS "reports",
           MAX(COALESCE(f."arrivedAt", f."receivedAt")) AS "lastSeen"
    FROM "dmarc_forensic_report" f
    WHERE f."domainId" = ${domainId}
    GROUP BY f."sourceIp"
  `;
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
