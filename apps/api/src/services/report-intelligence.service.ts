import { prisma } from '../database/prisma.js';
import { readDmarcRecord } from '../scanner/dmarc-tags.js';

const maxScannedRecords = 5_000;
const defaultTrendDays = 30;
const maximumTrendDays = 365;
const spikeStandardDeviations = 2;

export interface SourceAttribution {
  sourceIp: string;
  totalMessages: number;
  failedMessages: number;
  forensicMessages: number;
  reportCount: number;
  lastSeenAt: string | null;
  topSendingDomain: string | null;
  risk: 'high' | 'medium' | 'low';
}

export interface TrendPoint {
  date: string;
  reportsReceived: number;
  messagesObserved: number;
  failedMessages: number;
}

export interface TrendSpike {
  date: string;
  messagesObserved: number;
  averageMessages: number;
  multiple: number;
}

export interface DomainInsights {
  domain: { id: string; name: string; status: string; score: number | null };
  reporting: { aggregateConfigured: boolean; forensicConfigured: boolean; collectionEnabled: boolean; identityRetentionEnabled: boolean };
  aggregate: {
    reportCount: number;
    recordCount: number;
    messageCount: number;
    failedMessages: number;
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
}

interface AggregateRecord {
  sourceIp: string;
  messageCount: number;
  dkimResult: string | null;
  spfResult: string | null;
  receivedAt: Date;
  headerFrom: string | null;
  authResults: { type: string; domain: string | null }[];
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

function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
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
    forensicMessages: 0,
    reportCount: 0,
    lastSeenAt: null,
    topSendingDomain: null,
    risk: 'low' as const,
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
      id: domainId,
      client: { organizationId },
    },
    select: {
      id: true,
      name: true,
      status: true,
      score: true,
      dmarcRecord: true,
      collectForensicReports: true,
      retainForensicPii: true,
    },
  });

  if (!domain) {
    return null;
  }

  const [reports, forensics] = await Promise.all([
    prisma.dmarcReport.findMany({
      where: { domainId: domain.id },
      select: {
        receivedAt: true,
        dateRangeBegin: true,
        dateRangeEnd: true,
        records: {
          select: {
            sourceIp: true,
            messageCount: true,
            dkimResult: true,
            spfResult: true,
            headerFrom: true,
            authResults: { select: { type: true, domain: true } },
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
  ]);

  const sources = emptyMap();
  const buckets = new Map<string, TrendPoint>();
  let recordCount = 0;
  let messageCount = 0;
  let failedMessages = 0;
  let spfPass = 0;
  let dkimPass = 0;
  let lastReportAt: string | null = null;
  let windowBegin: string | null = null;
  let windowEnd: string | null = null;

  for (const report of reports) {
    recordCount += report.records.length;
    lastReportAt = latestIso(lastReportAt, report.receivedAt);
    windowBegin = latestIso(windowBegin, report.dateRangeBegin);
    windowEnd = latestIso(windowEnd, report.dateRangeEnd);

    const bucket = buckets.get(dayKey(report.receivedAt)) ?? {
      date: dayKey(report.receivedAt),
      reportsReceived: 0,
      messagesObserved: 0,
      failedMessages: 0,
    };
    bucket.reportsReceived += 1;
    buckets.set(bucket.date, bucket);

    for (const record of report.records as AggregateRecord[]) {
      messageCount += record.messageCount;
      bucket.messagesObserved += record.messageCount;

      const failed = !isPass(record.dkimResult) || !isPass(record.spfResult);
      if (failed) {
        failedMessages += record.messageCount;
        bucket.failedMessages += record.messageCount;
      }

      if (record.spfResult) {
        spfPass += isPass(record.spfResult) ? record.messageCount : 0;
      }
      if (record.dkimResult) {
        dkimPass += isPass(record.dkimResult) ? record.messageCount : 0;
      }

      const sendingDomain =
        record.authResults.find((result) => result.domain)?.domain ?? record.headerFrom ?? null;

      touchSource(sources, record.sourceIp, (entry) => {
        entry.totalMessages += record.messageCount;
        entry.reportCount += 1;
        entry.lastSeenAt = latestIso(entry.lastSeenAt, report.receivedAt);
        if (failed) {
          entry.failedMessages += record.messageCount;
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

    touchSource(sources, forensic.sourceIp, (entry) => {
      entry.forensicMessages += 1;
      entry.lastSeenAt = latestIso(entry.lastSeenAt, forensic.arrivedAt ?? forensic.receivedAt);
    });
  }

  const days = Math.min(Math.max(trendDays, 1), maximumTrendDays);
  const points = [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-days);
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

  return {
    domain: { id: domain.id, name: domain.name, status: domain.status, score: domain.score },
    reporting: {
      aggregateConfigured: tags.aggregateTargets.length > 0,
      forensicConfigured: tags.forensicTargets.length > 0,
      collectionEnabled: domain.collectForensicReports,
      identityRetentionEnabled: domain.retainForensicPii,
    },
    aggregate: {
      reportCount: reports.length,
      recordCount,
      messageCount,
      failedMessages,
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
  };
}
