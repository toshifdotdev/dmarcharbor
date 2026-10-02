/**
 * types.ts — response shapes mirrored from apps/api source (the OpenAPI
 * document exposes only ApiError and Page schemas, so these are hand-read from
 * the Prisma models and services). If an API change breaks one of these, the
 * typecheck fails loudly — that is the intended contract behavior.
 */

export type DomainStatus = "PENDING" | "VERIFIED" | "FAILED";

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
}

export interface DomainRow {
  id: string;
  clientId: string;
  name: string;
  status: DomainStatus;
  verifiedAt: string | null;
  dmarcPolicy: string | null;
  dmarcRecord: string | null;
  score: number | null;
  createdAt: string;
  lastScanAt: string | null;
}

export interface ClientRow {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  trustSlug?: string | null;
  createdAt: string;
  domains: DomainRow[];
}

/** The measurement subset of DomainInsights the portfolio needs. */
export interface DomainSignals {
  reportCount: number;
  messageCount: number;
  failedMessages: number;
  /** Messages from senders authenticating as a different domain than the one
   *  monitored — seen, but not attributed. Not a pass: an open question. */
  unattributedMessages: number;
  spfPassRate: number | null;
  dkimPassRate: number | null;
  lastReportAt: string | null;
  /**
   * The DMARC policy reporters observed in their reports (policy_published,
   * stored per report as policyP). Distinct from the domain row's
   * dmarcPolicy, which is only written by a DNS scan: a domain whose DNS has
   * never been scanned still has a real, observed policy in its evidence.
   */
  reportedPolicy: string | null;
}

// ─── domain detail (Phase 2) ──────────────────────────────────────────────────

export interface SenderRow {
  senderKey: string;
  senderDomain: string | null;
  sourceIps: string[];
  failingSourceIps: string[];
  totalMessages: number;
  failedMessages: number;
  failureSharePercent: number;
  hasEnoughSignal: boolean;
  status: "clean" | "degraded" | "failing" | "insufficient-data";
  firstSeenAt: string;
  lastSeenAt: string;
  isNew: boolean;
  newSenderRisk: { level: "high" | "medium" | "low"; reasons: string[] } | null;
  dkimPassMessages: number;
  spfPassMessages: number;
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

export interface SourceAttribution {
  sourceIp: string;
  totalMessages: number;
  failedMessages: number;
  forensicMessages: number;
  reportCount: number;
  lastSeenAt: string | null;
  topSendingDomain: string | null;
  risk: "high" | "medium" | "low";
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
  senders: SenderRow[];
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

export interface PolicyReadiness {
  level: "none" | "quarantine" | "reject";
  ready: boolean;
  currentPolicy: "none" | "quarantine" | "reject" | "unknown";
  daysObserved: number;
  messagesObserved: number;
  passRatePercent: number | null;
  openAlerts: number;
  staleAlerts: number;
  failingSenders: number;
  observedSenders: number;
  blockers: string[];
}

export interface OnboardingState {
  state:
    | "ADDED"
    | "AWAITING_VERIFICATION"
    | "AWAITING_DMARC_RECORD"
    | "AWAITING_REPORTS"
    | "MONITORING"
    | "NEEDS_ATTENTION";
  completedSteps: number;
  totalSteps: number;
  steps: Array<{
    id: string;
    title: string;
    status: "done" | "pending" | "blocked" | "optional";
    detail: string;
  }>;
  readiness: PolicyReadiness;
}

export interface ReportRow {
  id: string;
  receivedAt: string;
  dateRangeBegin: string | null;
  dateRangeEnd: string | null;
  reportId: string | null;
  reportingOrganization: string | null;
  policyP: string | null;
  records: Array<{
    id: string;
    sourceIp: string;
    messageCount: number;
    disposition: string | null;
    dkimResult: string | null;
    spfResult: string | null;
    headerFrom: string | null;
  }>;
}

export interface PageEnvelope<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: {
    code?: string;
    message?: string;
    feature?: string;
  };
}
