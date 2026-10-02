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
  domain: {
    id: string;
    name: string;
    status: string;
    score: number | null;
    dmarcPolicy: string | null;
  };
  reporting: {
    publishedPolicy: string | null;
    publishedPct: number;
    /**
     * Configured is NOT collectable. A rua=https record configures reporting
     * we cannot read; the aggregate_reporting step's status/detail carries that
     * distinction, and the UI must render it — never claim delivery for a
     * record whose reports go to a web endpoint (issue code
     * dmarc_aggregate_reports_not_collected).
     */
    aggregateConfigured: boolean;
    forensicConfigured: boolean;
    collectionEnabled: boolean;
    identityRetentionEnabled: boolean;
  };
  rollout: PctRecommendation;
  /** The API's own generated record — rendered verbatim, never assembled
   *  client-side, so pct, ruf and notes stay consistent with what the backend
   *  verifies. */
  suggestedRecord: DmarcRecordDraft;
  recommendedPolicy: "none" | "quarantine" | "reject";
}

export interface PctRecommendation {
  currentPct: number;
  recommendedPct: number;
  advancing: boolean;
  reason: string;
  skippedSteps: number;
}

export interface DmarcRecordDraft {
  host: string;
  type: "TXT";
  value: string;
  policy: "none" | "quarantine" | "reject";
  pct: number;
  aggregateAddress: string;
  forensicAddress: string | null;
  notes: string[];
}

/** POST /api/workspaces/{id}/domains/{domainId}/verify — runs the live DNS
 *  lookup and returns both the record to publish and the lookup outcome.
 *  `status: PENDING` is a normal propagation state, never an error. */
export interface VerifyDomainResult {
  domain: DomainRow;
  verification: {
    verified: boolean;
    lookupStatus: string;
    error?: string;
    host: string;
    type: "TXT";
    value: string;
    status: "VERIFIED" | "FAILED" | "PENDING";
  };
}

// ─── report shares (Phase 5) ─────────────────────────────────────────────────

export interface CreatedShare {
  id: string;
  token: string;
  /** The existing public surface, e.g. /api/reports/share/<token> — linked,
   *  never rebuilt. */
  url: string;
  expiresAt: string;
  includeForensics: boolean;
  includeSources: boolean;
}

export interface ReportShareRow {
  id: string;
  token: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  includeForensics: boolean;
  includeSources: boolean;
  createdAt: string;
  domain: { id: string; name: string };
  client: { id: string; name: string };
}

/** GET /api/auth/providers — the contract for federated sign-in. A provider is
 *  true only when BOTH its client id and secret exist, so half-finished OAuth
 *  config correctly renders no button. */
export interface AuthProviders {
  password: boolean;
  google: boolean;
  microsoft: boolean;
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

// ─── operations (Phase 3) ─────────────────────────────────────────────────────

export type EntitlementKey =
  | "reports.aggregate"
  | "reports.forensic"
  | "reports.forensicNamed"
  | "alerts.email"
  | "alerts.spoofing"
  | "rollout.canary"
  | "sharing.links"
  | "digests"
  | "audit.trail"
  | "portal.client"
  | "branding.whitelabel"
  | "api.access"
  | "auth.sso"
  | "data.export"
  | "data.erase"
  | "trust.center"
  | "reports.compliancePack"
  | "reports.inbox"
  | "branding.logoUpload";

export type QuotaKey = "client" | "activeDomain" | "member";

export interface PlanPriceMinor {
  monthlyMinor: number;
  annualMinor: number;
}

export interface PlanDefinition {
  tier: string;
  label: string;
  descriptor: string;
  prices: { USD: PlanPriceMinor; INR: PlanPriceMinor };
  maxClients: number;
  maxActiveDomains: number;
  maxMembers: number;
  dataRetentionDays: number;
  auditRetentionDays: number;
  features: Record<EntitlementKey, boolean>;
}

export interface ResolvedEntitlements {
  plan: string;
  label: string;
  status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELLED" | "EXPIRED" | "NONE";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  maxClients: number;
  maxActiveDomains: number;
  maxMembers: number;
  dataRetentionDays: number;
  auditRetentionDays: number;
  features: Partial<Record<EntitlementKey, boolean>>;
  overrides: Array<{ entitlement: string; enabled: boolean; expiresAt: string | null }>;
}

export interface BillingStatus {
  plan: string;
  status: string;
  provider: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  priceLabel: string;
  currency: "USD" | "INR";
}

export type AlertMetric =
  | "FAILURE_COUNT"
  | "FAILURE_RATE"
  | "SOURCE_IP_VOLUME"
  | "FORENSIC_FAILURES"
  | "REPORT_SILENCE"
  | "NEW_UNAUTHENTICATED_SOURCE";

export type AlertOperator = "GREATER_THAN" | "GREATER_THAN_OR_EQUAL" | "LESS_THAN";
// NOTE: the live API rejects LESS_THAN_OR_EQUAL and EQUAL with 400 (probed
// 2026-10-02; the source z.enum agrees). Only the three above are real.

export interface AlertRuleRow {
  id: string;
  domainId: string;
  domain: { id: string; name: string };
  name: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  maxReminderLevel: number;
  enabled: boolean;
  lastTriggeredAt: string | null;
  recipients: Array<{ userId: string }>;
}

export interface AlertEventRow {
  id: string;
  ruleId: string;
  rule: { id: string; name: string };
  domainId: string;
  domain: { id: string; name: string };
  metric: AlertMetric;
  operator: string;
  observedValue: number;
  threshold: number;
  summary: string;
  reminderLevel: number;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  staleAt: string | null;
  triggeredAt: string;
}

export interface ReportDigestRow {
  id: string;
  domainId: string;
  domain: { id: string; name: string; client: { id: string; name: string } };
  frequency: "WEEKLY" | "MONTHLY";
  sendHourUtc: number;
  weekday: number;
  dayOfMonth: number;
  recipientEmails: string[];
  includeForensics: boolean;
  enabled: boolean;
  lastSentAt: string | null;
}

export interface WorkspaceMemberRow {
  id: string;
  userId: string;
  role: string;
  user?: { id: string; name: string; email: string };
}

export interface BrandingSettings {
  brandLogoUrl: string | null;
  brandPrimaryColor: string | null;
  brandAccentColor: string | null;
  customDomain: string | null;
  customDomainVerifiedAt: string | null;
}

export interface ReportInboxSettings {
  configured: boolean;
  enabled: boolean;
  host: string | null;
  username: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface SsoConnectionRow {
  id: string;
  label: string;
  protocol: "SAML" | "OIDC";
  issuer: string;
  provisioning: "JIT" | "DISABLED";
  allowedEmailDomains: string[];
  defaultRole: "analyst" | "viewer" | "admin";
  /** The callback URL the customer's identity provider needs. Comes from the
   *  connection — never constructed in the UI. */
  callbackUrl?: string;
}

export interface CheckoutRequest {
  plan: string;
  interval: "monthly" | "annual";
  currency: "USD" | "INR";
  contact: { name: string; email: string; taxId?: string | null };
}

export interface CheckoutSummary {
  checkoutUrl?: string;
  [key: string]: unknown;
}

// ─── public artefacts (Phase 4) ──────────────────────────────────────────────

/** GET /api/trust/{slug} — served unauthenticated to auditors. */
export interface TrustCenterPayload {
  generatedAt: string;
  client: { name: string; domains: string[] };
  provider: { workspaceName: string };
  statement: {
    isolation: string;
    coveredByTests: string;
    lawEnforcementRequests: string;
  };
  dataHeld: { category: string; description: string; containsPersonalData: boolean }[];
  access: { role: string; canRead: string }[];
  retention: { data: string; audit: string; deletionWindow: string };
  residency: { region: string; hosting: string };
  subProcessors: { name: string; purpose: string; data: string }[];
  rights: { export: string; erasure: string };
  erasures: { scope: string; completedAt: string; recordCount: number }[];
}

/** GET /api/compliance-packs/verify?reference= — the published fingerprint
 *  only: never the document, never a client name. */
export interface CompliancePackRecord {
  reference: string;
  sha256: string;
  byteSize: number;
  pageCount: number;
  asOf: string;
  createdAt: string;
  supersededAt: string | null;
  documentVersion: string;
}

/** GET /api/workspaces/{id}/clients/{clientId}/trust-center */
export interface TrustSlugStatus {
  url: string | null;
  slug: string | null;
}

/** POST /api/workspaces/{id}/clients/{clientId}/compliance-packs → PDF bytes
 *  streamed with the digest in X-DMARC-Pack-Sha256. */
export interface IssuedPackMeta {
  reference: string;
  sha256: string;
  byteSize: number;
  pageCount: number;
  asOf: string;
  documentVersion: string;
}

// ─── client portal (Phase 4) ─────────────────────────────────────────────────

/** GET /api/portal — the contact's view. Verified domains only. NEVER
 *  forensic data: portal contacts are outside that boundary by contract. */
export interface PortalGrantSummary {
  id: string;
  clientId: string;
  clientName: string;
  email: string;
  displayName: string | null;
  active: boolean;
  bound: boolean;
}

export interface PortalOverview {
  workspace: { name: string };
  branding: PortalBranding;
  grants: PortalGrantSummary[];
  clients: Array<{
    id: string;
    name: string;
    createdAt: string;
    domains: Array<{
      id: string;
      name: string;
      status: string;
      score: number | null;
      dmarcPolicy: string | null;
      verifiedAt: string | null;
      lastScanAt: string | null;
    }>;
  }>;
  totals: { clients: number; domains: number; reports: number };
  lastReportAt: string | null;
}

/** GET /api/portal/domains/{domainId} */
export interface PortalDomainDetail {
  domain: {
    id: string;
    name: string;
    status: string;
    score: number | null;
    dmarcPolicy: string | null;
    dmarcRecord: string | null;
    verifiedAt: string | null;
    lastScanAt: string | null;
    client: { id: string; name: string };
  };
  aggregate: {
    reportCount: number;
    recordCount: number;
    messageCount: number;
    failedMessages: number;
    spfPassRate: number | null;
    dkimPassRate: number | null;
    lastReportAt: string | null;
    messageWindow: { begin: string | null; end: string | null };
  } | null;
  senders: Array<{
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
    dkimPassMessages: number;
    spfPassMessages: number;
  }>;
  possibleSpoofingSources: Array<{
    senderKey: string;
    senderDomain: string | null;
    totalMessages: number;
    failedMessages: number;
    sourceIps: string[];
  }>;
}

/** GET /api/portal/branding — resolved server-side (ResolvedBranding); the
 *  response is what a contact may see. A user-typed logo URL never appears
 *  here (filtered server-side); rendering one would be a security bug. */
export interface PortalBranding {
  /** The agency name shown to their clients. */
  workspaceName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  customDomain: string | null;
  customDomainVerified: boolean;
  /** True only when the portal should present the agency brand. */
  branded: boolean;
}

export interface ApiErrorBody {
  error: {
    code?: string;
    message?: string;
    /** Entitlement key on 402 FEATURE_NOT_IN_PLAN. Routes the upgrade prompt. */
    feature?: string;
    /** Quota key on 402 PLAN_LIMIT_REACHED. */
    quota?: string;
    /** The API's own plan wording on a 402 — quoted, never rebuilt in the UI. */
    plan?: string;
    planLabel?: string;
    requiredIn?: string;
    upgradeTo?: string;
  };
}
