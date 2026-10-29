import { prisma } from '../../database/prisma.js';
import { toCsv } from '../../utils/csv.js';
import { parseMonthlyPeriod, previousCompleteMonth, type MonthlyPeriod } from './monthly-period.js';

/**
 * What each client used in one calendar month, for an MSP to bill against.
 *
 * One row per client in the workspace, including clients with nothing to show,
 * so the export lines up with the client list the agency bills from. Every
 * figure is attributed the way the monthly client report attributes it: an
 * aggregate report belongs to the month its reporting period begins in, not
 * the day it arrived, so this file and that PDF agree on every number.
 *
 * Only complete months, at most the last twelve: a bill for a month still
 * running would change after it was sent, and reports older than that are
 * past the retention most deployments keep.
 */

export interface ClientUsage {
  clientId: string;
  clientName: string;
  clientSlug: string;
  /** Domains that existed by the end of the month. */
  domains: number;
  /** Of those, verified by the end of the month. */
  verifiedDomains: number;
  /** Domains that received a report for the month, or were added in it. */
  activeDomains: number;
  /** Aggregate reports for the month. */
  reports: number;
  /** Messages those reports cover. */
  messages: number;
  /** Messages that passed DMARC (an aligned DKIM or SPF pass). */
  dmarcPassMessages: number;
  /** Pass rate to one decimal place, or null when there were no messages. */
  dmarcPassPercent: number | null;
  /** Forensic (failure) reports received in the month. */
  forensicReports: number;
  /** Alerts opened in the month. */
  alertsOpened: number;
}

export interface UsageExport {
  period: { key: string; label: string; start: string; end: string };
  generatedAt: string;
  clients: ClientUsage[];
  totals: Omit<ClientUsage, 'clientId' | 'clientName' | 'clientSlug' | 'dmarcPassPercent'> & {
    dmarcPassPercent: number | null;
  };
}

/** The requested month, or the last complete one when none is given. */
export function resolveUsagePeriod(input: string | undefined, now = new Date()): MonthlyPeriod {
  // Workspace-wide, so there is no client creation date to bound it by.
  return input && input.trim() ? parseMonthlyPeriod(input, now, new Date(0)) : previousCompleteMonth(now);
}

function percent(passed: number, total: number): number | null {
  return total > 0 ? Math.round((passed * 1000) / total) / 10 : null;
}

interface Counted {
  clientId: string;
  value: bigint | number;
}

function byClient(rows: Counted[]): Map<string, number> {
  return new Map(rows.map((row) => [row.clientId, Number(row.value)]));
}

export async function buildUsageExport(organizationId: string, period: MonthlyPeriod, now = new Date()): Promise<UsageExport> {
  const { start, end } = period;

  const [clients, domainRows, activeRows, messageRows, forensicRows, alertRows] = await Promise.all([
    prisma.client.findMany({
      where: { organizationId },
      select: { id: true, name: true, slug: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    prisma.$queryRaw<Array<{ clientId: string; domains: bigint; verified: bigint }>>`
      SELECT d."clientId" AS "clientId",
             COUNT(*)::bigint AS "domains",
             COUNT(*) FILTER (WHERE d."verifiedAt" IS NOT NULL AND d."verifiedAt" < ${end})::bigint AS "verified"
      FROM "domain" d
      JOIN "client" c ON c.id = d."clientId"
      WHERE c."organizationId" = ${organizationId} AND d."createdAt" < ${end}
      GROUP BY d."clientId"
    `,
    prisma.$queryRaw<Counted[]>`
      SELECT d."clientId" AS "clientId", COUNT(*)::bigint AS "value"
      FROM "domain" d
      JOIN "client" c ON c.id = d."clientId"
      WHERE c."organizationId" = ${organizationId}
        AND (
          (d."createdAt" >= ${start} AND d."createdAt" < ${end})
          OR EXISTS (
            SELECT 1 FROM "dmarc_report" r
            WHERE r."domainId" = d.id AND r."dateRangeBegin" >= ${start} AND r."dateRangeBegin" < ${end}
          )
        )
      GROUP BY d."clientId"
    `,
    prisma.$queryRaw<Array<{ clientId: string; reports: bigint; messages: bigint; passed: bigint }>>`
      SELECT c.id AS "clientId",
             COUNT(DISTINCT r.id)::bigint AS "reports",
             COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages",
             COALESCE(SUM(CASE WHEN lower(rec."dkimResult") = 'pass' OR lower(rec."spfResult") = 'pass' THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "passed"
      FROM "dmarc_report" r
      JOIN "domain" d ON d.id = r."domainId"
      JOIN "client" c ON c.id = d."clientId"
      LEFT JOIN "dmarc_report_record" rec ON rec."reportId" = r.id
      WHERE c."organizationId" = ${organizationId}
        AND r."reportType" = 'AGGREGATE'
        AND r."dateRangeBegin" >= ${start} AND r."dateRangeBegin" < ${end}
      GROUP BY c.id
    `,
    prisma.$queryRaw<Counted[]>`
      SELECT d."clientId" AS "clientId", COUNT(*)::bigint AS "value"
      FROM "dmarc_forensic_report" f
      JOIN "domain" d ON d.id = f."domainId"
      JOIN "client" c ON c.id = d."clientId"
      WHERE c."organizationId" = ${organizationId}
        AND f."receivedAt" >= ${start} AND f."receivedAt" < ${end}
      GROUP BY d."clientId"
    `,
    prisma.$queryRaw<Counted[]>`
      SELECT d."clientId" AS "clientId", COUNT(*)::bigint AS "value"
      FROM "alert_event" e
      JOIN "domain" d ON d.id = e."domainId"
      JOIN "client" c ON c.id = d."clientId"
      WHERE c."organizationId" = ${organizationId} AND e."organizationId" = ${organizationId}
        AND e."triggeredAt" >= ${start} AND e."triggeredAt" < ${end}
      GROUP BY d."clientId"
    `,
  ]);

  const domains = new Map(domainRows.map((row) => [row.clientId, { total: Number(row.domains), verified: Number(row.verified) }]));
  const active = byClient(activeRows);
  const messages = new Map(
    messageRows.map((row) => [row.clientId, { reports: Number(row.reports), messages: Number(row.messages), passed: Number(row.passed) }]),
  );
  const forensic = byClient(forensicRows);
  const alerts = byClient(alertRows);

  const rows: ClientUsage[] = clients.map((client) => {
    const volume = messages.get(client.id) ?? { reports: 0, messages: 0, passed: 0 };
    return {
      clientId: client.id,
      clientName: client.name,
      clientSlug: client.slug,
      domains: domains.get(client.id)?.total ?? 0,
      verifiedDomains: domains.get(client.id)?.verified ?? 0,
      activeDomains: active.get(client.id) ?? 0,
      reports: volume.reports,
      messages: volume.messages,
      dmarcPassMessages: volume.passed,
      dmarcPassPercent: percent(volume.passed, volume.messages),
      forensicReports: forensic.get(client.id) ?? 0,
      alertsOpened: alerts.get(client.id) ?? 0,
    };
  });

  const sum = (pick: (row: ClientUsage) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const totalMessages = sum((row) => row.messages);
  const totalPassed = sum((row) => row.dmarcPassMessages);

  return {
    period: { key: period.key, label: period.label, start: start.toISOString(), end: end.toISOString() },
    generatedAt: now.toISOString(),
    clients: rows,
    totals: {
      domains: sum((row) => row.domains),
      verifiedDomains: sum((row) => row.verifiedDomains),
      activeDomains: sum((row) => row.activeDomains),
      reports: sum((row) => row.reports),
      messages: totalMessages,
      dmarcPassMessages: totalPassed,
      dmarcPassPercent: percent(totalPassed, totalMessages),
      forensicReports: sum((row) => row.forensicReports),
      alertsOpened: sum((row) => row.alertsOpened),
    },
  };
}

export const usageCsvHeader = [
  'month',
  'client',
  'client_slug',
  'client_id',
  'domains',
  'verified_domains',
  'active_domains',
  'aggregate_reports',
  'messages',
  'dmarc_pass_messages',
  'dmarc_pass_percent',
  'forensic_reports',
  'alerts_opened',
] as const;

/** One row per client, then a totals row, so a spreadsheet sum is not needed. */
export function usageCsv(usage: UsageExport): string {
  const rows = usage.clients.map((row) => [
    usage.period.key,
    row.clientName,
    row.clientSlug,
    row.clientId,
    row.domains,
    row.verifiedDomains,
    row.activeDomains,
    row.reports,
    row.messages,
    row.dmarcPassMessages,
    row.dmarcPassPercent,
    row.forensicReports,
    row.alertsOpened,
  ]);
  const t = usage.totals;
  rows.push([
    usage.period.key,
    'All clients',
    '',
    '',
    t.domains,
    t.verifiedDomains,
    t.activeDomains,
    t.reports,
    t.messages,
    t.dmarcPassMessages,
    t.dmarcPassPercent,
    t.forensicReports,
    t.alertsOpened,
  ]);
  return toCsv(usageCsvHeader, rows);
}

export function usageFilename(workspaceSlug: string, period: MonthlyPeriod, format: 'csv' | 'json'): string {
  const slug = workspaceSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
  return `dmarc-harbor-usage-${slug}-${period.key}.${format}`.replace(/[^A-Za-z0-9._-]/g, '-');
}
