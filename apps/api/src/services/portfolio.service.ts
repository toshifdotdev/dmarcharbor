import { prisma } from '../database/prisma.js';
import { hasAggregateReporting, readDmarcRecord } from '../scanner/dmarc-tags.js';
import { readinessThresholds, type OnboardingState, type ReadinessLevel } from './onboarding.service.js';

export interface PortfolioDomainRow {
  domainId: string;
  domainName: string;
  clientId: string;
  clientName: string;
  state: OnboardingState;
  verified: boolean;
  dmarcPolicy: string | null;
  aggregateConfigured: boolean;
  forensicConfigured: boolean;
  collectionEnabled: boolean;
  reportCount: number;
  openAlerts: number;
  staleAlerts: number;
  messagesObserved: number;
  passRatePercent: number | null;
  recommendedPolicy: ReadinessLevel;
  topBlocker: string | null;
}

export interface PortfolioReport {
  totals: {
    clients: number;
    domains: number;
    verified: number;
    monitoring: number;
    needsAttention: number;
    awaitingVerification: number;
    awaitingDmarcRecord: number;
    awaitingReports: number;
    readyToTighten: number;
  };
  clients: {
    clientId: string;
    clientName: string;
    domains: PortfolioDomainRow[];
  }[];
}

function daySpan(from: Date | null, to: Date): number {
  if (!from) {
    return 0;
  }
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

export async function getPortfolioOnboarding(organizationId: string, now = new Date()): Promise<PortfolioReport> {
  const domains = await prisma.domain.findMany({
    where: { client: { organizationId } },
    select: {
      id: true,
      name: true,
      status: true,
      dmarcPolicy: true,
      dmarcRecord: true,
      collectForensicReports: true,
      client: { select: { id: true, name: true } },
      _count: { select: { dmarcReports: true } },
    },
    orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
  });

  const domainIds = domains.map((domain) => domain.id);

  const [reportStats, openAlertStats, staleAlertStats, records, windowStats] = await Promise.all([
    domainIds.length
      ? prisma.dmarcReport.groupBy({
          by: ['domainId'],
          where: { domainId: { in: domainIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    domainIds.length
      ? prisma.alertEvent.groupBy({
          by: ['domainId'],
          where: {
            domainId: { in: domainIds },
            acknowledgedAt: null,
            resolvedAt: null,
            staleAt: null,
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    domainIds.length
      ? prisma.alertEvent.groupBy({
          by: ['domainId'],
          where: {
            domainId: { in: domainIds },
            acknowledgedAt: null,
            resolvedAt: null,
            staleAt: { not: null },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    domainIds.length
      ? prisma.dmarcReportRecord.findMany({
          where: { report: { domainId: { in: domainIds } } },
          select: {
            messageCount: true,
            dkimResult: true,
            spfResult: true,
            report: { select: { domainId: true, dateRangeBegin: true, dateRangeEnd: true } },
          },
          take: 20_000,
        })
      : Promise.resolve([]),
    domainIds.length
      ? prisma.dmarcReport.findMany({
          where: { domainId: { in: domainIds } },
          select: { domainId: true, dateRangeBegin: true, dateRangeEnd: true },
        })
      : Promise.resolve([]),
  ]);

  const reportCountByDomain = new Map(reportStats.map((row) => [row.domainId, row._count._all]));
  const openAlertsByDomain = new Map(openAlertStats.map((row) => [row.domainId, row._count._all]));
  const staleAlertsByDomain = new Map(staleAlertStats.map((row) => [row.domainId, row._count._all]));

  const perDomain = new Map<
    string,
    { messages: number; spfPassed: number; dkimPassed: number; spfSeen: number; dkimSeen: number; windowBegin: Date | null }
  >();

  for (const domain of domains) {
    perDomain.set(domain.id, {
      messages: 0,
      spfPassed: 0,
      dkimPassed: 0,
      spfSeen: 0,
      dkimSeen: 0,
      windowBegin: null,
    });
  }

  for (const window of windowStats) {
    const entry = perDomain.get(window.domainId);
    if (entry && window.dateRangeBegin && (!entry.windowBegin || window.dateRangeBegin < entry.windowBegin)) {
      entry.windowBegin = window.dateRangeBegin;
    }
  }

  for (const record of records) {
    const entry = perDomain.get(record.report.domainId);
    if (!entry) {
      continue;
    }

    entry.messages += record.messageCount;
    if (record.spfResult) {
      entry.spfSeen += record.messageCount;
      if (record.spfResult.trim().toLowerCase() === 'pass') {
        entry.spfPassed += record.messageCount;
      }
    }
    if (record.dkimResult) {
      entry.dkimSeen += record.messageCount;
      if (record.dkimResult.trim().toLowerCase() === 'pass') {
        entry.dkimPassed += record.messageCount;
      }
    }
  }

  const rows: PortfolioDomainRow[] = domains.map((domain) => {
    const verified = domain.status === 'VERIFIED';
    const tags = readDmarcRecord(domain.dmarcRecord);
    const aggregateConfigured = hasAggregateReporting(tags);
    const forensicConfigured = tags.forensicTargets.length > 0;
    const dmarcPublished = tags.tags.v?.toLowerCase() === 'dmarc1';
    const reportCount = reportCountByDomain.get(domain.id) ?? 0;
    const openAlerts = openAlertsByDomain.get(domain.id) ?? 0;
    const staleAlerts = staleAlertsByDomain.get(domain.id) ?? 0;
    const stats = perDomain.get(domain.id) ?? {
      messages: 0,
      spfPassed: 0,
      dkimPassed: 0,
      spfSeen: 0,
      dkimSeen: 0,
      windowBegin: null,
    };

    const rates: number[] = [];
    if (stats.spfSeen) {
      rates.push((stats.spfPassed / stats.spfSeen) * 100);
    }
    if (stats.dkimSeen) {
      rates.push((stats.dkimPassed / stats.dkimSeen) * 100);
    }
    const averageRate = rates.length ? rates.reduce((total, value) => total + value, 0) / rates.length : null;
    const passRatePercent =
      averageRate === null ? null : Math.round(averageRate * 100) / 100;
    const daysObserved = daySpan(stats.windowBegin, now);

    const blockers: string[] = [];
    if (stats.messages < readinessThresholds.minimumMessages) {
      blockers.push(
        `Only ${stats.messages} messages observed. At least ${readinessThresholds.minimumMessages} are needed before changing policy.`,
      );
    }
    if (daysObserved < readinessThresholds.minimumDaysObserved) {
      blockers.push(
        `Only ${daysObserved} days of reporting observed. At least ${readinessThresholds.minimumDaysObserved} days are needed.`,
      );
    }
    if (passRatePercent === null) {
      blockers.push('No SPF or DKIM results have been observed yet.');
    } else if (100 - passRatePercent > 100 - readinessThresholds.quarantinePassRatePercent) {
      blockers.push(
        `Pass rate is ${passRatePercent}%. At least ${readinessThresholds.quarantinePassRatePercent}% is required for p=quarantine.`,
      );
    }
    if (openAlerts > 0) {
      blockers.push(`${openAlerts} alert(s) are still open on this domain.`);
    }
    if (staleAlerts > 0) {
      blockers.push(`${staleAlerts} alert(s) have gone stale and need review.`);
    }

    const readyForQuarantine = blockers.length === 0;
    const rejectBlockers = [...blockers];
    if (passRatePercent !== null && 100 - passRatePercent > 100 - readinessThresholds.rejectPassRatePercent) {
      rejectBlockers.push(
        `Pass rate is ${passRatePercent}%. At least ${readinessThresholds.rejectPassRatePercent}% is required for p=reject.`,
      );
    }
    const recommendedPolicy: ReadinessLevel = readyForQuarantine
      ? rejectBlockers.length === 0
        ? 'reject'
        : 'quarantine'
      : 'none';

    const state: OnboardingState = !verified
      ? 'AWAITING_VERIFICATION'
      : !dmarcPublished || !aggregateConfigured
        ? 'AWAITING_DMARC_RECORD'
        : reportCount === 0
          ? 'AWAITING_REPORTS'
          : openAlerts + staleAlerts > 0
            ? 'NEEDS_ATTENTION'
            : 'MONITORING';

    return {
      domainId: domain.id,
      domainName: domain.name,
      clientId: domain.client.id,
      clientName: domain.client.name,
      state,
      verified,
      dmarcPolicy: domain.dmarcPolicy,
      aggregateConfigured,
      forensicConfigured,
      collectionEnabled: domain.collectForensicReports,
      reportCount,
      openAlerts,
      staleAlerts,
      messagesObserved: stats.messages,
      passRatePercent,
      recommendedPolicy,
      topBlocker: blockers[0] ?? null,
    };
  });

  const clientsMap = new Map<string, PortfolioReport['clients'][number]>();
  for (const row of rows) {
    const existing = clientsMap.get(row.clientId);
    if (existing) {
      existing.domains.push(row);
      continue;
    }
    clientsMap.set(row.clientId, { clientId: row.clientId, clientName: row.clientName, domains: [row] });
  }

  return {
    totals: {
      clients: clientsMap.size,
      domains: rows.length,
      verified: rows.filter((row) => row.verified).length,
      monitoring: rows.filter((row) => row.state === 'MONITORING').length,
      needsAttention: rows.filter((row) => row.state === 'NEEDS_ATTENTION').length,
      awaitingVerification: rows.filter((row) => row.state === 'AWAITING_VERIFICATION').length,
      awaitingDmarcRecord: rows.filter((row) => row.state === 'AWAITING_DMARC_RECORD').length,
      awaitingReports: rows.filter((row) => row.state === 'AWAITING_REPORTS').length,
      readyToTighten: rows.filter((row) => row.recommendedPolicy !== 'none').length,
    },
    clients: [...clientsMap.values()],
  };
}
