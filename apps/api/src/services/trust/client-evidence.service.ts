import { prisma } from '../../database/prisma.js';
import type { ScanResult } from '../../models/scan.model.js';
import { isOurAddress } from '../report-address.service.js';
import { classifySender } from '../sender-breakdown.service.js';
import {
  historySummary,
  policyLabel,
  readPosture,
  type DomainPostureReading,
  type ReportingTarget,
} from './client-evidence.js';

/**
 * The evidence the Trust Center and the compliance pack state about one
 * client's domains: posture from the newest DNS check, the DMARC policy
 * history, monitoring coverage, a sender summary and the open findings.
 *
 * One collector for both documents, so the public page and the signed PDF can
 * never disagree about the same client on the same day.
 *
 * Scoped to one client throughout. Every query is anchored on the client id
 * AND the workspace that owns it, never on the workspace alone: an agency holds
 * many clients and both documents leave the product, so a sibling client's row
 * here would be a permanent disclosure.
 *
 * Everything is measured up to `asOf` and nothing reads the clock, so the pack
 * renders the same bytes for the same facts. Queries carry a full ordering for
 * the same reason.
 */

/** The window coverage and sender counts are measured over. */
export const evidenceWindowDays = 90;

const dayMs = 24 * 60 * 60 * 1000;

export interface DomainCoverage {
  reporting: ReportingTarget;
  /** The newest aggregate report received for this domain, at or before asOf. */
  lastReportAt: string | null;
  /** The start of the earliest aggregate report period still held. */
  firstPeriodAt: string | null;
  reportsInWindow: number;
  /** Distinct UTC days on which a report period began, inside the window. */
  daysMeasured: number;
  reporters: number;
  tlsReportsInWindow: number;
  lastTlsReportAt: string | null;
}

export interface DomainSenders {
  sources: number;
  approved: number;
  notOurs: number;
  unreviewed: number;
  /** Sources with enough mail to judge that fail DMARC on more than 5% of it, not counting those marked not ours. */
  failing: number;
  messages: number;
  dmarcPass: number;
}

export interface DomainEvidence {
  name: string;
  ownership: 'verified' | 'pending' | 'failed';
  verifiedAt: string | null;
  addedAt: string;
  posture: DomainPostureReading;
  coverage: DomainCoverage;
  senders: DomainSenders;
}

export interface PolicyHistoryEntry {
  domain: string;
  at: string;
  kind: 'first-check' | 'change' | 'approved' | 'declined';
  text: string;
}

export interface ClientEvidence {
  asOf: string;
  windowDays: number;
  windowStart: string;
  /** Every domain the client has, which can be more than `domains` lists. */
  domainCount: number;
  domains: DomainEvidence[];
  history: PolicyHistoryEntry[];
  /** Entries before the cap; more than `history.length` when some were left out. */
  historyTotal: number;
  findings: {
    alerts: { domain: string; openedAt: string; summary: string; acknowledged: boolean }[];
    alertCount: number;
    changes: { domain: string; detectedAt: string; severity: 'warning' | 'critical'; summary: string }[];
    changeCount: number;
    checks: { domain: string; severity: 'error' | 'warning'; title: string }[];
    proposals: { domain: string; proposedAt: string; from: string; to: string; expiresAt: string }[];
  };
  totals: {
    enforcing: number;
    monitoringOnly: number;
    noPolicy: number;
    notChecked: number;
    reportingHere: number;
    receivingReports: number;
    sources: number;
    messages: number;
    dmarcPass: number;
    openFindings: number;
  };
  checks: { oldest: string | null; newest: string | null };
  reports: { inWindow: number; reporters: number; earliestPeriod: string | null; latestReceived: string | null };
}

interface LatestScanRow {
  domainId: string;
  completedAt: Date | null;
  result: unknown;
}

interface FirstScanRow {
  domainId: string;
  completedAt: Date | null;
  policy: string | null;
  status: string | null;
}

interface CoverageRow {
  domainId: string;
  lastReceivedAt: Date | null;
  firstPeriodAt: Date | null;
  reportsInWindow: number;
  daysMeasured: number;
  reporters: number;
}

interface ClientReportRow {
  reports: number;
  reporters: number;
  firstPeriodAt: Date | null;
  lastReceivedAt: Date | null;
}

interface TlsRow {
  domainId: string;
  reportsInWindow: number;
  lastReceivedAt: Date | null;
}

interface SenderRow {
  domainId: string;
  senderKey: string;
  messages: bigint | number;
  dmarcPass: bigint | number;
}

function toNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

const historyPerDomain = 12;

/**
 * Gathers the evidence for one client as of a moment.
 *
 * `domainLimit` bounds the work on a public endpoint; `domainCount` still says
 * how many there are, so a document can say plainly that it lists some.
 */
export async function collectClientEvidence(input: {
  clientId: string;
  organizationId: string;
  asOf: Date;
  domainLimit: number;
}): Promise<ClientEvidence> {
  const { clientId, organizationId, asOf } = input;
  const windowStart = new Date(asOf.getTime() - evidenceWindowDays * dayMs);
  const clientScope = { clientId, client: { organizationId } };

  const [domainRows, domainCount] = await Promise.all([
    prisma.domain.findMany({
      where: clientScope,
      select: { id: true, name: true, status: true, verifiedAt: true, createdAt: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: input.domainLimit,
    }),
    prisma.domain.count({ where: clientScope }),
  ]);

  const [
    latestScans,
    firstScans,
    coverageRows,
    clientReports,
    tlsRows,
    senderRows,
    reviews,
    alerts,
    alertCount,
    openChanges,
    openChangeCount,
    historyChanges,
    proposals,
  ] = await Promise.all([
    // The newest completed check at or before asOf. The heavy parts of the stored
    // result (the SPF include tree, the MTA-STS policy text, DKIM key bodies and the
    // score breakdown) are dropped in the query: neither document prints them.
    prisma.$queryRaw<LatestScanRow[]>`
      SELECT d.id AS "domainId", latest."completedAt" AS "completedAt", latest.result AS result
      FROM "domain" d
      JOIN "client" c ON c.id = d."clientId"
      LEFT JOIN LATERAL (
        SELECT s."completedAt",
               ((s.result - 'scoreBreakdown') #- '{spf,lookupTree}' #- '{mtaSts,policy,text}' #- '{dkim,records}') AS result
        FROM "scan" s
        WHERE s."domainId" = d.id
          AND s."status" = 'COMPLETED'
          AND s."completedAt" <= ${asOf}
        ORDER BY s."completedAt" DESC, s."startedAt" DESC, s.id DESC
        LIMIT 1
      ) latest ON true
      WHERE c.id = ${clientId} AND c."organizationId" = ${organizationId}
    `,
    prisma.$queryRaw<FirstScanRow[]>`
      SELECT DISTINCT ON (s."domainId") s."domainId" AS "domainId", s."completedAt" AS "completedAt",
             s.result->'dmarc'->>'policy' AS policy, s.result->'dmarc'->>'status' AS status
      FROM "scan" s
      JOIN "domain" d ON d.id = s."domainId"
      JOIN "client" c ON c.id = d."clientId"
      WHERE c.id = ${clientId} AND c."organizationId" = ${organizationId}
        AND s."status" = 'COMPLETED'
        AND s."completedAt" <= ${asOf}
      ORDER BY s."domainId", s."completedAt" ASC, s.id ASC
    `,
    prisma.$queryRaw<CoverageRow[]>`
      SELECT r."domainId" AS "domainId",
             MAX(r."receivedAt") AS "lastReceivedAt",
             MIN(r."dateRangeBegin") AS "firstPeriodAt",
             (COUNT(*) FILTER (WHERE r."dateRangeBegin" >= ${windowStart} AND r."dateRangeBegin" < ${asOf}))::int AS "reportsInWindow",
             (COUNT(DISTINCT date_trunc('day', r."dateRangeBegin")) FILTER (WHERE r."dateRangeBegin" >= ${windowStart} AND r."dateRangeBegin" < ${asOf}))::int AS "daysMeasured",
             (COUNT(DISTINCT NULLIF(r."reportingOrganization", '')) FILTER (WHERE r."dateRangeBegin" >= ${windowStart} AND r."dateRangeBegin" < ${asOf}))::int AS "reporters"
      FROM "dmarc_report" r
      JOIN "domain" d ON d.id = r."domainId"
      JOIN "client" c ON c.id = d."clientId"
      WHERE c.id = ${clientId} AND c."organizationId" = ${organizationId}
        AND r."reportType" = 'AGGREGATE'
        AND r."receivedAt" <= ${asOf}
      GROUP BY r."domainId"
    `,
    prisma.$queryRaw<ClientReportRow[]>`
      SELECT COUNT(*)::int AS "reports",
             COUNT(DISTINCT NULLIF(r."reportingOrganization", ''))::int AS "reporters",
             MIN(r."dateRangeBegin") AS "firstPeriodAt",
             MAX(r."receivedAt") AS "lastReceivedAt"
      FROM "dmarc_report" r
      JOIN "domain" d ON d.id = r."domainId"
      JOIN "client" c ON c.id = d."clientId"
      WHERE c.id = ${clientId} AND c."organizationId" = ${organizationId}
        AND r."reportType" = 'AGGREGATE'
        AND r."receivedAt" <= ${asOf}
        AND r."dateRangeBegin" >= ${windowStart} AND r."dateRangeBegin" < ${asOf}
    `,
    prisma.$queryRaw<TlsRow[]>`
      SELECT t."domainId" AS "domainId",
             (COUNT(*) FILTER (WHERE t."dateRangeBegin" >= ${windowStart} AND t."dateRangeBegin" < ${asOf}))::int AS "reportsInWindow",
             MAX(t."receivedAt") AS "lastReceivedAt"
      FROM "tls_report" t
      JOIN "domain" d ON d.id = t."domainId"
      JOIN "client" c ON c.id = d."clientId"
      WHERE c.id = ${clientId} AND c."organizationId" = ${organizationId}
        AND t."receivedAt" <= ${asOf}
      GROUP BY t."domainId"
    `,
    // One row per domain and sender: the domain the mail authenticated as, or the
    // sending IP where no domain was reported, which is the same key the sender
    // review uses.
    prisma.$queryRaw<SenderRow[]>`
      SELECT r."domainId" AS "domainId",
             COALESCE(rec."senderKey", rec."sourceIp" || '|unknown') AS "senderKey",
             SUM(rec."messageCount")::bigint AS "messages",
             SUM(CASE WHEN lower(rec."dkimResult") = 'pass' OR lower(rec."spfResult") = 'pass' THEN rec."messageCount" ELSE 0 END)::bigint AS "dmarcPass"
      FROM "dmarc_report_record" rec
      JOIN "dmarc_report" r ON r.id = rec."reportId"
      JOIN "domain" d ON d.id = r."domainId"
      JOIN "client" c ON c.id = d."clientId"
      WHERE c.id = ${clientId} AND c."organizationId" = ${organizationId}
        AND r."reportType" = 'AGGREGATE'
        AND r."receivedAt" <= ${asOf}
        AND r."dateRangeBegin" >= ${windowStart} AND r."dateRangeBegin" < ${asOf}
      GROUP BY r."domainId", 2
      ORDER BY r."domainId", 2
      LIMIT 20000
    `,
    prisma.senderReview.findMany({
      where: { organizationId, domain: clientScope, status: { not: null }, reviewedAt: { lte: asOf } },
      select: { domainId: true, senderKey: true, status: true },
    }),
    prisma.alertEvent.findMany({
      where: {
        organizationId,
        domain: clientScope,
        triggeredAt: { lte: asOf },
        OR: [{ resolvedAt: null }, { resolvedAt: { gt: asOf } }],
      },
      select: { domainId: true, summary: true, triggeredAt: true, acknowledgedAt: true },
      orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
      take: 40,
    }),
    prisma.alertEvent.count({
      where: {
        organizationId,
        domain: clientScope,
        triggeredAt: { lte: asOf },
        OR: [{ resolvedAt: null }, { resolvedAt: { gt: asOf } }],
      },
    }),
    prisma.dnsChange.findMany({
      where: {
        organizationId,
        domain: clientScope,
        severity: { in: ['WARNING', 'CRITICAL'] },
        detectedAt: { gte: windowStart, lte: asOf },
        OR: [{ acknowledgedAt: null }, { acknowledgedAt: { gt: asOf } }],
      },
      select: { domainId: true, severity: true, code: true, summary: true, detectedAt: true },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: 40,
    }),
    prisma.dnsChange.count({
      where: {
        organizationId,
        domain: clientScope,
        severity: { in: ['WARNING', 'CRITICAL'] },
        detectedAt: { gte: windowStart, lte: asOf },
        OR: [{ acknowledgedAt: null }, { acknowledgedAt: { gt: asOf } }],
      },
    }),
    prisma.dnsChange.findMany({
      where: {
        organizationId,
        domain: clientScope,
        kind: { in: ['DMARC_POLICY', 'DMARC_RECORD', 'DMARC_RUA'] },
        detectedAt: { lte: asOf },
      },
      select: { domainId: true, code: true, summary: true, detectedAt: true },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: 400,
    }),
    prisma.policyProposal.findMany({
      where: { organizationId, domain: clientScope, createdAt: { lte: asOf } },
      select: {
        domainId: true,
        fromPolicy: true,
        fromTesting: true,
        policy: true,
        testing: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        appliedAt: true,
        expiresAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    }),
  ]);

  const names = new Map(domainRows.map((row) => [row.id, row.name]));
  const listed = (domainId: string) => names.has(domainId);

  const scanByDomain = new Map(latestScans.map((row) => [row.domainId, row]));
  const coverageByDomain = new Map(coverageRows.map((row) => [row.domainId, row]));
  const tlsByDomain = new Map(tlsRows.map((row) => [row.domainId, row]));
  const reviewByKey = new Map(reviews.map((row) => [`${row.domainId}\u0000${row.senderKey}`, row.status]));

  const sendersByDomain = new Map<string, DomainSenders>();
  for (const row of senderRows) {
    if (!listed(row.domainId)) continue;
    const entry =
      sendersByDomain.get(row.domainId) ??
      { sources: 0, approved: 0, notOurs: 0, unreviewed: 0, failing: 0, messages: 0, dmarcPass: 0 };
    const messages = toNumber(row.messages);
    const pass = toNumber(row.dmarcPass);
    const review = reviewByKey.get(`${row.domainId}\u0000${row.senderKey}`) ?? null;
    entry.sources += 1;
    entry.messages += messages;
    entry.dmarcPass += pass;
    if (review === 'APPROVED') entry.approved += 1;
    else if (review === 'NOT_OURS') entry.notOurs += 1;
    else entry.unreviewed += 1;
    if (review !== 'NOT_OURS' && classifySender(messages, messages - pass) === 'failing') entry.failing += 1;
    sendersByDomain.set(row.domainId, entry);
  }

  const domains: DomainEvidence[] = domainRows.map((row) => {
    const scan = scanByDomain.get(row.id);
    const result = scan?.result && typeof scan.result === 'object' ? (scan.result as ScanResult) : null;
    const posture = readPosture(result, scan?.completedAt ?? null, isOurAddress);
    const coverage = coverageByDomain.get(row.id);
    const tls = tlsByDomain.get(row.id);
    return {
      name: row.name,
      ownership: row.status === 'VERIFIED' ? 'verified' : row.status === 'FAILED' ? 'failed' : 'pending',
      verifiedAt: iso(row.verifiedAt),
      addedAt: row.createdAt.toISOString(),
      posture,
      coverage: {
        reporting: posture.dmarc.reporting,
        lastReportAt: iso(coverage?.lastReceivedAt),
        firstPeriodAt: iso(coverage?.firstPeriodAt),
        reportsInWindow: toNumber(coverage?.reportsInWindow),
        daysMeasured: toNumber(coverage?.daysMeasured),
        reporters: toNumber(coverage?.reporters),
        tlsReportsInWindow: toNumber(tls?.reportsInWindow),
        lastTlsReportAt: iso(tls?.lastReceivedAt),
      },
      senders: sendersByDomain.get(row.id) ?? { sources: 0, approved: 0, notOurs: 0, unreviewed: 0, failing: 0, messages: 0, dmarcPass: 0 },
    };
  });

  // Policy history: the earliest check still held, the DMARC changes seen
  // between checks, and the policy changes the client decided on.
  const historyByDomain = new Map<string, PolicyHistoryEntry[]>();
  const push = (domainId: string, entry: Omit<PolicyHistoryEntry, 'domain'>) => {
    const name = names.get(domainId);
    if (!name) return;
    const list = historyByDomain.get(domainId) ?? [];
    list.push({ domain: name, ...entry });
    historyByDomain.set(domainId, list);
  };

  for (const row of firstScans) {
    if (!row.completedAt) continue;
    const policy = row.policy;
    const text =
      row.status === 'found' && policy && policy !== 'unknown'
        ? `Earliest check held: p=${policy} was published.`
        : row.status === 'missing'
          ? 'Earliest check held: no DMARC record was published.'
          : 'Earliest check held: the DMARC record could not be read.';
    push(row.domainId, { at: row.completedAt.toISOString(), kind: 'first-check', text });
  }

  for (const row of historyChanges) {
    push(row.domainId, { at: row.detectedAt.toISOString(), kind: 'change', text: historySummary(row.code, row.summary) });
  }

  const pending: ClientEvidence['findings']['proposals'] = [];
  for (const row of proposals) {
    const decidedInTime = row.decidedAt !== null && row.decidedAt.getTime() <= asOf.getTime();
    const change = `${policyLabel(row.fromPolicy, row.fromTesting)} to ${policyLabel(row.policy, row.testing)}`;
    if ((row.status === 'APPROVED' || row.status === 'DECLINED') && decidedInTime && row.decidedAt) {
      const applied = row.status === 'APPROVED' && row.appliedAt && row.appliedAt.getTime() <= asOf.getTime();
      push(row.domainId, {
        at: row.decidedAt.toISOString(),
        kind: row.status === 'APPROVED' ? 'approved' : 'declined',
        text:
          row.status === 'APPROVED'
            ? `The client approved a change from ${change}.${applied ? ' The hosted record was updated.' : ''}`
            : `The client declined a proposed change from ${change}.`,
      });
      continue;
    }
    const open = row.status === 'PENDING' || ((row.status === 'APPROVED' || row.status === 'DECLINED') && !decidedInTime);
    if (open && row.expiresAt.getTime() > asOf.getTime() && names.has(row.domainId)) {
      pending.push({
        domain: names.get(row.domainId)!,
        proposedAt: row.createdAt.toISOString(),
        from: policyLabel(row.fromPolicy, row.fromTesting),
        to: policyLabel(row.policy, row.testing),
        expiresAt: row.expiresAt.toISOString(),
      });
    }
  }

  let historyTotal = 0;
  const history: PolicyHistoryEntry[] = [];
  for (const row of domainRows) {
    const entries = (historyByDomain.get(row.id) ?? []).sort(
      (a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text),
    );
    historyTotal += entries.length;
    if (entries.length > historyPerDomain) {
      // Keep the earliest check and the newest changes: the starting point and
      // where it has got to are what a reader needs.
      const first = entries[0]!.kind === 'first-check' ? [entries[0]!] : [];
      history.push(...first, ...entries.slice(entries.length - (historyPerDomain - first.length)));
    } else {
      history.push(...entries);
    }
  }

  const checks: ClientEvidence['findings']['checks'] = [];
  for (const domain of domains) {
    for (const issue of domain.posture.issues) {
      checks.push({ domain: domain.name, severity: issue.severity, title: issue.title });
    }
  }

  const alertsListed = alerts
    .filter((row) => listed(row.domainId))
    .map((row) => ({
      domain: names.get(row.domainId)!,
      openedAt: row.triggeredAt.toISOString(),
      summary: row.summary,
      acknowledged: row.acknowledgedAt !== null && row.acknowledgedAt.getTime() <= asOf.getTime(),
    }));

  const changesListed = openChanges
    .filter((row) => listed(row.domainId))
    .map((row) => ({
      domain: names.get(row.domainId)!,
      detectedAt: row.detectedAt.toISOString(),
      severity: (row.severity === 'CRITICAL' ? 'critical' : 'warning') as 'warning' | 'critical',
      summary: historySummary(row.code, row.summary),
    }));

  const checkedTimes = domains
    .map((domain) => domain.posture.checkedAt)
    .filter((value): value is string => value !== null)
    .sort();

  const clientReport = clientReports[0];

  const totals = domains.reduce(
    (sum, domain) => {
      const dmarc = domain.posture.dmarc;
      if (dmarc.policy === 'quarantine' || dmarc.policy === 'reject') sum.enforcing += 1;
      else if (dmarc.policy === 'none') sum.monitoringOnly += 1;
      else if (dmarc.state === 'fail') sum.noPolicy += 1;
      else sum.notChecked += 1;
      if (domain.coverage.reporting === 'this-service') sum.reportingHere += 1;
      if (domain.coverage.reportsInWindow > 0) sum.receivingReports += 1;
      sum.sources += domain.senders.sources;
      sum.messages += domain.senders.messages;
      sum.dmarcPass += domain.senders.dmarcPass;
      return sum;
    },
    {
      enforcing: 0,
      monitoringOnly: 0,
      noPolicy: 0,
      notChecked: 0,
      reportingHere: 0,
      receivingReports: 0,
      sources: 0,
      messages: 0,
      dmarcPass: 0,
      openFindings: 0,
    },
  );
  totals.openFindings = alertCount + openChangeCount + checks.length;

  return {
    asOf: asOf.toISOString(),
    windowDays: evidenceWindowDays,
    windowStart: windowStart.toISOString(),
    domainCount,
    domains,
    history,
    historyTotal,
    findings: {
      alerts: alertsListed,
      alertCount,
      changes: changesListed,
      changeCount: openChangeCount,
      checks,
      proposals: pending.sort((a, b) => a.domain.localeCompare(b.domain) || a.proposedAt.localeCompare(b.proposedAt)),
    },
    totals,
    checks: { oldest: checkedTimes[0] ?? null, newest: checkedTimes[checkedTimes.length - 1] ?? null },
    reports: {
      inWindow: toNumber(clientReport?.reports),
      reporters: toNumber(clientReport?.reporters),
      earliestPeriod: iso(clientReport?.firstPeriodAt),
      latestReceived: iso(clientReport?.lastReceivedAt),
    },
  };
}
