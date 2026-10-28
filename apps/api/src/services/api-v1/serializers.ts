/**
 * api-v1/serializers.ts — the public shape of every v1 response.
 *
 * **Why this file exists.** The browser routes hand their service objects
 * straight to `response.json`. That is fine for a page that ships with the API:
 * the two change together. It is not fine for `/api/v1`, which is a contract
 * with software we cannot redeploy. A column added to `Domain` would appear in a
 * customer's integration without anybody deciding it should, and a column
 * removed would break it — so every v1 response is built here, from an explicit
 * allowlist of fields, and nothing else.
 *
 * The rules each function follows:
 *
 * - **Named fields only.** No spread of a Prisma row, ever. A new column cannot
 *   leak because the only way into the response is to be written on this line.
 * - **Dates are ISO strings.** A `Date` serialises to a string in JSON anyway,
 *   but `.toISOString()` makes it a decision rather than a coincidence, and it
 *   pins the format.
 * - **Ids are strings.** They already are; the point is that they are named
 *   `...Id` or `id` so a consumer can tell one from a name.
 * - **Nothing sensitive, ever.** No forensic personal data (email addresses,
 *   subjects, bodies), no credentials, no tokens, no encrypted columns, and no
 *   other workspace's rows. The queries that feed these functions are already
 *   scoped to the key's workspace; this file is the second half of that promise.
 *
 * tests/api-v1-serializers.unit.test.ts asserts the exact key set of each
 * function, so adding a field here without listing it there fails the suite.
 * That is deliberate friction: every field on this surface is a promise.
 */

import type { ResolvedEntitlements } from '../entitlements/entitlement.service.js';
import type { SenderBreakdownRow } from '../sender-breakdown.service.js';
import type { TlsReportSummary } from '../tls-report/tls-report-query.service.js';
import type { DnsChangeRow } from '../monitoring/dns-change.service.js';

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** JSON columns hold `unknown`; the API promises an array of strings. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

// ─── GET /me ─────────────────────────────────────────────────────────────────

export interface MeInput {
  organization: { id: string; name: string; slug: string };
  entitlements: ResolvedEntitlements;
  key: { id: string; name: string; scopes: string[]; expiresAt: Date | null };
}

export function serializeMe(input: MeInput) {
  return {
    workspace: {
      id: input.organization.id,
      name: input.organization.name,
      slug: input.organization.slug,
    },
    plan: {
      tier: input.entitlements.plan,
      label: input.entitlements.label,
      status: input.entitlements.status,
      currentPeriodEnd: input.entitlements.currentPeriodEnd,
    },
    /**
     * The flags, as a plain `{ key: boolean }` object.
     *
     * An integration asks "may I call the reports endpoint" and should not have
     * to know the plan tiers. The keys are the same entitlement keys the browser
     * uses, so the two cannot drift into two vocabularies for one licence.
     */
    features: { ...input.entitlements.features },
    limits: {
      maxClients: input.entitlements.maxClients,
      maxActiveDomains: input.entitlements.maxActiveDomains,
      maxMembers: input.entitlements.maxMembers,
    },
    key: {
      id: input.key.id,
      name: input.key.name,
      scopes: [...input.key.scopes],
      expiresAt: iso(input.key.expiresAt),
    },
  };
}

// ─── GET /domains/{domain} ───────────────────────────────────────────────────

export interface DomainDetailInput {
  id: string;
  name: string;
  slug: string;
  status: string;
  dmarcPolicy: string | null;
  dmarcRecord: string | null;
  verifiedAt: Date | null;
  score: number | null;
  collectForensicReports: boolean;
  lastScanAt: Date | null;
  spfRecord: string | null;
  mxRecords: unknown;
  dkimSelectors: unknown;
  client: { id: string; name: string; slug: string };
}

/**
 * One domain, with the same fields the list returns plus the four a caller needs
 * to reason about its health without a second call.
 */
export function serializeDomainDetail(row: DomainDetailInput) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    dmarcPolicy: row.dmarcPolicy,
    dmarcRecord: row.dmarcRecord,
    verifiedAt: iso(row.verifiedAt),
    score: row.score,
    collectForensicReports: row.collectForensicReports,
    lastScanAt: iso(row.lastScanAt),
    spfRecord: row.spfRecord,
    mxRecords: stringList(row.mxRecords),
    dkimSelectors: stringList(row.dkimSelectors),
    client: { id: row.client.id, name: row.client.name, slug: row.client.slug },
  };
}

// ─── GET /domains/{domain}/scans ─────────────────────────────────────────────

export interface ScanRowInput {
  id: string;
  status: string;
  trigger: string;
  score: number | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  changeCount?: number;
}

/**
 * A scan, without its `result` JSON.
 *
 * `result` is the scanner's whole working document — every record it read, every
 * DKIM selector it tried — and it is both large and internal. A caller that
 * needs the detail asks for the domain, which carries the conclusions.
 */
export function serializeScan(row: ScanRowInput) {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    score: row.score,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    completedAt: iso(row.completedAt),
    changeCount: row.changeCount ?? 0,
  };
}

// ─── GET /domains/{domain}/reports ───────────────────────────────────────────

export interface ReportRowInput {
  id: string;
  reportId: string | null;
  reportingOrganization: string | null;
  reportType: string;
  dateRangeBegin: Date | null;
  dateRangeEnd: Date | null;
  receivedAt: Date;
  recordCount: number;
  records: Array<{ messageCount: number; dkimResult: string | null; spfResult: string | null }>;
}

function passed(value: string | null): boolean {
  return (value ?? '').trim().toLowerCase() === 'pass';
}

/**
 * A report header with its counts, and **no row-level data**.
 *
 * The records underneath carry source IP addresses and envelope senders: that is
 * the personal-data-adjacent part of a DMARC report, and it is not something a
 * list endpoint should hand to any key that happens to hold `read`. The counts
 * answer the question a reporting integration actually asks — how much mail, how
 * much of it failed — and the detail stays behind the browser interface.
 */
export function serializeReport(row: ReportRowInput) {
  const messageCount = row.records.reduce((total, record) => total + record.messageCount, 0);
  // DMARC passes when either aligned check passed, which is the same rule the
  // rest of the product counts by. Counting only DKIM would report failures that
  // the domain did not have.
  const passedMessages = row.records.reduce(
    (total, record) =>
      total + (passed(record.dkimResult) || passed(record.spfResult) ? record.messageCount : 0),
    0,
  );

  return {
    id: row.id,
    reportId: row.reportId,
    reportingOrganization: row.reportingOrganization,
    reportType: row.reportType,
    dateRangeBegin: iso(row.dateRangeBegin),
    dateRangeEnd: iso(row.dateRangeEnd),
    receivedAt: row.receivedAt.toISOString(),
    recordCount: row.recordCount,
    messageCount,
    passedMessages,
    failedMessages: messageCount - passedMessages,
  };
}

// ─── GET /domains/{domain}/senders ───────────────────────────────────────────

/**
 * One sending service, with the fields the Senders table shows.
 *
 * `sourceIps` and `failingSourceIps` are deliberately absent: the breakdown
 * computes them, but a list of addresses is exactly the row-level data the report
 * serializer above refuses to publish. A caller that needs to block an address
 * can see it in the browser, where a person is making the decision.
 */
export function serializeSender(row: SenderBreakdownRow) {
  return {
    /**
     * `service` is the stable identifier an integration can key on; `serviceName`
     * is what the Senders table prints. Both, because a caller matching on
     * "sendgrid" should not have to know we renamed a label, and a caller
     * showing a report to a person should not have to carry a lookup table.
     */
    service: row.service?.id ?? null,
    serviceName: row.service?.name ?? null,
    senderDomain: row.senderDomain,
    totalMessages: row.totalMessages,
    failedMessages: row.failedMessages,
    dmarcFailedMessages: row.dmarcFailedMessages,
    failureSharePercent: row.failureSharePercent,
    dkimPassMessages: row.dkimPassMessages,
    spfPassMessages: row.spfPassMessages,
    status: row.status,
    confidence: row.confidence,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    isNew: row.isNew,
    review: {
      status: row.review.status,
      note: row.review.note,
      reviewedAt: row.review.reviewedAt,
    },
  };
}

// ─── GET /alerts ─────────────────────────────────────────────────────────────

export interface AlertRowInput {
  id: string;
  ruleId: string;
  metric: string;
  operator: string;
  observedValue: number;
  threshold: number;
  windowMinutes: number;
  summary: string;
  reminderLevel: number;
  triggeredAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  domain: { id: string; name: string; slug: string };
  rule: { id: string; name: string } | null;
}

export function serializeAlert(row: AlertRowInput) {
  // One word for the state, because a consumer filtering "open" should not have
  // to combine two nullable timestamps and guess which wins.
  const state = row.resolvedAt ? 'resolved' : row.acknowledgedAt ? 'acknowledged' : 'open';

  return {
    id: row.id,
    state,
    ruleId: row.ruleId,
    ruleName: row.rule?.name ?? null,
    domain: { id: row.domain.id, name: row.domain.name, slug: row.domain.slug },
    metric: row.metric,
    operator: row.operator,
    observedValue: row.observedValue,
    threshold: row.threshold,
    windowMinutes: row.windowMinutes,
    summary: row.summary,
    reminderLevel: row.reminderLevel,
    triggeredAt: row.triggeredAt.toISOString(),
    acknowledgedAt: iso(row.acknowledgedAt),
    resolvedAt: iso(row.resolvedAt),
  };
}

// ─── GET /dns-changes ────────────────────────────────────────────────────────

export function serializeDnsChange(row: DnsChangeRow) {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    code: row.code,
    summary: row.summary,
    detectedAt: row.detectedAt.toISOString(),
    scanId: row.scanId,
    acknowledgedAt: iso(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy?.name ?? null,
  };
}

// ─── GET /domains/{domain}/tls-reports/summary ───────────────────────────────

export function serializeTlsSummary(summary: TlsReportSummary) {
  return {
    days: summary.days,
    reportCount: summary.reportCount,
    successfulSessions: summary.successfulSessions,
    failedSessions: summary.failedSessions,
    failureSharePercent: summary.failureSharePercent,
    lastReportAt: summary.lastReportAt,
    byResultType: summary.byResultType.map((row) => ({
      resultType: row.resultType,
      failedSessions: row.failedSessions,
      reporters: [...row.reporters],
    })),
    byMxHost: summary.byMxHost.map((row) => ({
      receivingMxHostname: row.receivingMxHostname,
      failedSessions: row.failedSessions,
      resultTypes: [...row.resultTypes],
    })),
    byPolicyType: summary.byPolicyType.map((row) => ({
      policyType: row.policyType,
      successfulSessions: row.successfulSessions,
      failedSessions: row.failedSessions,
    })),
    record: {
      status: summary.record.status,
      host: summary.record.host,
      current: summary.record.current,
      suggested: summary.record.suggested,
    },
  };
}

// ─── GET /domains/{domain}/policy-readiness ──────────────────────────────────

/**
 * Passed through as the service returns it.
 *
 * The readiness document is already a purpose-built, presentation-shaped answer
 * (a list of blockers with plain sentences), it contains no ids or personal data,
 * and inventing a second shape for the same advice would guarantee the browser
 * and the API eventually disagree about what blocks a policy.
 */
export function serializePolicyReadiness<T extends { blockers?: unknown }>(readiness: T): T {
  return readiness;
}
