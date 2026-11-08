/**
 * report-aggregates.service.ts — the aggregate report figures, counted in the
 * database, for any number of domains in one query each.
 *
 * The domain page asks for one domain and the portfolio for every domain in a
 * workspace; both read the same queries here, so a domain's figures on the
 * portfolio are the figures on its own page. Nothing loads report records into
 * memory: the cost is one grouped query per figure, whatever the volume.
 *
 * DMARC passes as passesDmarc() decides it: DKIM or SPF passed. A message
 * fails DMARC when both failed.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';

/** passesDmarc() in SQL. */
export const DKIM_PASS = Prisma.sql`lower(trim(COALESCE(rec."dkimResult", ''))) = 'pass'`;
export const SPF_PASS = Prisma.sql`lower(trim(COALESCE(rec."spfResult", ''))) = 'pass'`;

/** How far back the policy history reads. Older reports are usually past retention anyway. */
const policyHistoryDays = 730;

export interface DomainTotals {
  reports: number;
  records: number;
  messages: number;
  failed: number;
  partial: number;
  spf: number;
  dkim: number;
  lastReportAt: string | null;
  windowBegin: string | null;
  windowEnd: string | null;
}

export interface DailyPoint {
  date: string;
  reportsReceived: number;
  messagesObserved: number;
  failedMessages: number;
  spfPassMessages: number;
  dkimPassMessages: number;
}

export interface PolicyChange {
  date: string;
  policy: string;
}

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

export const emptyTotals = (): DomainTotals => ({
  reports: 0,
  records: 0,
  messages: 0,
  failed: 0,
  partial: 0,
  spf: 0,
  dkim: 0,
  lastReportAt: null,
  windowBegin: null,
  windowEnd: null,
});

interface TotalsRow {
  domainId: string;
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

/** Every domain's figures over every aggregate report held (retention bounds them). */
export async function totalsByDomain(domainIds: string[]): Promise<Map<string, DomainTotals>> {
  const out = new Map<string, DomainTotals>();
  if (domainIds.length === 0) return out;
  const rows = await prisma.$queryRaw<TotalsRow[]>`
    SELECT r."domainId" AS "domainId",
           COUNT(DISTINCT r.id)::bigint AS "reports",
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
    WHERE r."domainId" = ANY(${domainIds}::text[])
      AND r."reportType" = 'AGGREGATE'
    GROUP BY r."domainId"
  `;
  for (const row of rows) {
    out.set(row.domainId, {
      reports: Number(row.reports),
      records: Number(row.records),
      messages: Number(row.messages),
      failed: Number(row.failed),
      partial: Number(row.partial),
      spf: Number(row.spf),
      dkim: Number(row.dkim),
      lastReportAt: iso(row.lastReceived),
      windowBegin: iso(row.windowBegin),
      windowEnd: iso(row.windowEnd),
    });
  }
  return out;
}

interface DailyRow {
  domainId: string;
  day: string;
  reports: bigint;
  messages: bigint;
  failed: bigint;
  spf: bigint;
  dkim: bigint;
}

/**
 * One point per domain per UTC day (by the day the report was received) that
 * had an aggregate report, over the last `days` days ending today.
 */
export async function dailyPointsByDomain(domainIds: string[], days: number, now = new Date()): Promise<Map<string, DailyPoint[]>> {
  const out = new Map<string, DailyPoint[]>();
  if (domainIds.length === 0) return out;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(today - (days - 1) * 86_400_000);
  const rows = await prisma.$queryRaw<DailyRow[]>`
    SELECT r."domainId" AS "domainId",
           to_char(r."receivedAt", 'YYYY-MM-DD') AS "day",
           COUNT(DISTINCT r.id)::bigint AS "reports",
           COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages",
           COALESCE(SUM(CASE WHEN rec.id IS NOT NULL AND NOT (${DKIM_PASS}) AND NOT (${SPF_PASS}) THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "failed",
           COALESCE(SUM(CASE WHEN ${SPF_PASS} THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "spf",
           COALESCE(SUM(CASE WHEN ${DKIM_PASS} THEN rec."messageCount" ELSE 0 END), 0)::bigint AS "dkim"
    FROM "dmarc_report" r
    LEFT JOIN "dmarc_report_record" rec ON rec."reportId" = r.id
    WHERE r."domainId" = ANY(${domainIds}::text[])
      AND r."reportType" = 'AGGREGATE'
      AND r."receivedAt" >= ${since}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
  for (const row of rows) {
    const list = out.get(row.domainId) ?? [];
    list.push({
      date: row.day,
      reportsReceived: Number(row.reports),
      messagesObserved: Number(row.messages),
      failedMessages: Number(row.failed),
      spfPassMessages: Number(row.spf),
      dkimPassMessages: Number(row.dkim),
    });
    out.set(row.domainId, list);
  }
  return out;
}

interface PolicyDayRow {
  domainId: string;
  day: string;
  policy: string;
  reports: bigint;
}

/**
 * The published policy as reporters saw it, one step per change, oldest first.
 *
 * Each day takes the policy most of that day's reports carried, so a receiver
 * still reporting from a cached DNS record on the day of a change does not
 * draw the policy flapping back and forth.
 */
export async function policyHistoryByDomain(domainIds: string[], now = new Date()): Promise<Map<string, PolicyChange[]>> {
  const out = new Map<string, PolicyChange[]>();
  if (domainIds.length === 0) return out;
  const since = new Date(now.getTime() - policyHistoryDays * 86_400_000);
  const rows = await prisma.$queryRaw<PolicyDayRow[]>`
    SELECT r."domainId" AS "domainId",
           to_char(r."receivedAt", 'YYYY-MM-DD') AS "day",
           lower(trim(r."policyP")) AS "policy",
           COUNT(*)::bigint AS "reports"
    FROM "dmarc_report" r
    WHERE r."domainId" = ANY(${domainIds}::text[])
      AND r."reportType" = 'AGGREGATE'
      AND r."receivedAt" >= ${since}
      AND r."policyP" IS NOT NULL
      AND trim(r."policyP") <> ''
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 4 DESC, 3
  `;
  const lastDay = new Map<string, string>();
  for (const row of rows) {
    // Ordered by domain, day, then report count: a day's first row is its policy.
    if (lastDay.get(row.domainId) === row.day) continue;
    lastDay.set(row.domainId, row.day);
    const steps = out.get(row.domainId) ?? [];
    if (steps.length === 0 || steps[steps.length - 1]!.policy !== row.policy) {
      steps.push({ date: row.day, policy: row.policy });
    }
    out.set(row.domainId, steps);
  }
  return out;
}

/**
 * The policy in each domain's newest report (policy_published), as a receiver
 * saw it. A DNS scan writes the domain row's own policy; this is the evidence.
 */
export async function latestReportedPolicyByDomain(domainIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (domainIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ domainId: string; policyP: string | null }>>`
    SELECT DISTINCT ON (r."domainId") r."domainId" AS "domainId", r."policyP" AS "policyP"
    FROM "dmarc_report" r
    WHERE r."domainId" = ANY(${domainIds}::text[])
      AND r."reportType" = 'AGGREGATE'
    ORDER BY r."domainId", r."receivedAt" DESC, r.id DESC
  `;
  for (const row of rows) out.set(row.domainId, row.policyP);
  return out;
}

/**
 * Messages from senders that authenticated as some other domain than the one
 * monitored, or a name under it: seen, but not attributed. Counted per record,
 * so a sender whose name changed is counted by what each record said.
 */
export async function unattributedByDomain(domainIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (domainIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ domainId: string; messages: bigint }>>`
    SELECT r."domainId" AS "domainId", COALESCE(SUM(rec."messageCount"), 0)::bigint AS "messages"
    FROM "dmarc_report_record" rec
    JOIN "dmarc_report" r ON r.id = rec."reportId"
    JOIN "domain" d ON d.id = r."domainId"
    WHERE r."domainId" = ANY(${domainIds}::text[])
      AND r."reportType" = 'AGGREGATE'
      -- The domain itself or a name under it is this domain's own mail: the
      -- parser stores the aligned domain, and mail.example.com aligns with
      -- example.com (session 4: Resend signing as mail.dmarcharbor.com read
      -- as 100% unattributed).
      AND lower(COALESCE(rec."senderDomain", '')) <> lower(d."name")
      AND right(lower(COALESCE(rec."senderDomain", '')), length(d."name") + 1) <> '.' || lower(d."name")
    GROUP BY 1
  `;
  for (const row of rows) out.set(row.domainId, Number(row.messages));
  return out;
}

export interface DomainSignalsRow {
  domainId: string;
  reportCount: number;
  messageCount: number;
  /** DMARC failures: both aligned checks failed. */
  failedMessages: number;
  /** Messages from senders authenticating as a different domain. */
  unattributedMessages: number;
  spfPassRate: number | null;
  dkimPassRate: number | null;
  lastReportAt: string | null;
  /** The policy in the newest report, as its receiver saw it published. */
  reportedPolicy: string | null;
  trend: DailyPoint[];
  policyHistory: PolicyChange[];
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 10_000) / 100 : null);

/**
 * The portfolio's measurement for every domain in a workspace, in six grouped
 * queries whatever the number of domains. This replaces two requests per
 * domain from the web app, which a workspace with hundreds of domains could
 * not afford on every page load.
 */
export async function workspaceSignals(
  organizationId: string,
  days = 30,
  now = new Date(),
): Promise<{ days: number; domains: DomainSignalsRow[] }> {
  const domains = await prisma.domain.findMany({
    where: { client: { organizationId } },
    select: { id: true },
  });
  const ids = domains.map((domain) => domain.id);
  const [totals, daily, history, reported, unattributed] = await Promise.all([
    totalsByDomain(ids),
    dailyPointsByDomain(ids, days, now),
    policyHistoryByDomain(ids, now),
    latestReportedPolicyByDomain(ids),
    unattributedByDomain(ids),
  ]);
  return {
    days,
    domains: ids.map((domainId) => {
      const t = totals.get(domainId) ?? emptyTotals();
      return {
        domainId,
        reportCount: t.reports,
        messageCount: t.messages,
        failedMessages: t.failed,
        unattributedMessages: unattributed.get(domainId) ?? 0,
        spfPassRate: percent(t.spf, t.messages),
        dkimPassRate: percent(t.dkim, t.messages),
        lastReportAt: t.lastReportAt,
        reportedPolicy: reported.get(domainId) ?? null,
        trend: daily.get(domainId) ?? [],
        policyHistory: history.get(domainId) ?? [],
      };
    }),
  };
}
