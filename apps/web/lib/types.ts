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

// ─── settings sections (Phase 6) ─────────────────────────────────────────────

/** GET /slack-destination — null before one is configured. The webhook URL
 *  NEVER comes back: maskedUrl is the host plus its last four characters, and
 *  there is nothing to fetch to populate an edit form. Editing means the owner
 *  pastes a new URL. */
export interface SlackDestination {
  channelLabel: string | null;
  enabled: boolean;
  maskedUrl: string;
  lastDeliveredAt: string | null;
  /** Surfaced so a broken webhook is visible before anyone wonders why alerts
   *  went quiet. */
  consecutiveFailures: number;
  lastError: string | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  /** Display prefix only — enough to tell keys apart, never a secret. */
  prefix: string;
  scopes: Array<"read" | "write">;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  expiresAt?: string | null;
}

/** POST /api-keys — `key` is returned EXACTLY ONCE and cannot be retrieved
 *  again; only its prefix survives for display. */
export interface IssuedApiKey {
  id: string;
  name: string;
  prefix: string;
  key: string;
  scopes: Array<"read" | "write">;
  expiresAt: string;
  notice?: string;
}

/**
 * The four events an endpoint can subscribe to. Kept as a literal union so the
 * UI offers exactly what the API's `webhookEvents` enum accepts, and the list
 * endpoint is still the source of truth for rendering order.
 */
export type WebhookEventName =
  | "domain.verified"
  | "alert.triggered"
  | "report.received"
  | "entitlement.exceeded";

/** GET /webhooks — one row per registered endpoint. `active` is already the
 *  effective state (paused OR auto-suspended), so the UI never re-derives it.
 *  The signing secret is NOT here and never will be. */
export interface WebhookEndpointRow {
  id: string;
  name: string;
  url: string;
  events: WebhookEventName[];
  active: boolean;
  /** Set when the endpoint was auto-suspended after too many failures. */
  suspendedAt: string | null;
  failureCount: number;
  lastDeliveryAt: string | null;
  createdAt: string;
}

/** POST /webhooks — the ONLY response carrying `secret`. It is shown once and
 *  is not retrievable afterwards, so the UI must present it before anything
 *  else. */
export interface RegisteredWebhook extends WebhookEndpointRow {
  secret: string;
  notice?: string;
}

export type WebhookDeliveryStatus =
  | "PENDING"
  | "IN_FLIGHT"
  | "DELIVERED"
  | "FAILED"
  | "SUSPENDED";

/** GET /webhook-deliveries — one row per event per endpoint, newest first. */
export interface WebhookDeliveryRow {
  id: string;
  endpointId: string;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  /** The endpoint's own HTTP status, or null when the request never landed. */
  responseCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/** An export is a REQUEST that is prepared, then available — not an instant
 *  download. */
export interface ExportJob {
  id: string;
  scope: "ORGANIZATION" | "CLIENT" | "DOMAIN";
  scopeLabel: string;
  format: "JSON" | "CSV";
  /**
   * READY, REVOKED or EXPIRED, straight from the API. An export is built before
   * the row exists, so there is no "preparing" state to model here.
   */
  state: "READY" | "REVOKED" | "EXPIRED";
  downloadExpiresAt: string | null;
  downloadedAt: string | null;
  createdAt: string;
  /**
   * Only ever present on the response that created the export, and only there by
   * design: the API stores the token as a hash and no endpoint returns it again.
   * The UI keeps it in state so a link the operator just created still works;
   * it cannot be recovered for an export created in an earlier session, which is
   * why the copy below says so rather than showing a dead control.
   */
  downloadUrl?: string;
}

export interface PlannedAction {
  key: string;
  label: string;
  count: number;
  action: "delete" | "anonymize" | "retain";
  reason: string;
  basis: string;
  containsPersonalData: boolean;
}

/** GET /erasures/preview — what an erasure would do, before it does anything. */
export interface ErasurePreview {
  scope: "ORGANIZATION" | "CLIENT" | "DOMAIN";
  scopeLabel: string;
  plan: string;
  actions: PlannedAction[];
  totals: {
    personalDataRecords: number;
    recordsDeleted: number;
    recordsAnonymised: number;
    evidenceRetained: number;
  };
  executeAfter?: string;
}

export interface ErasureRequestRow {
  id: string;
  scope: "ORGANIZATION" | "CLIENT" | "DOMAIN";
  targetId: string | null;
  reason: string | null;
  state: "PENDING" | "EXECUTED" | "CANCELLED" | string;
  purgeAfter: string;
  createdAt?: string;
  requestedById?: string | null;
  certificate?: unknown;
}

/** POST /erasures → 202: a destructive request enters a grace period before
 *  anything is deleted. */
export interface ErasureCreated {
  id: string;
  state: "PENDING";
  purgeAfter: string;
  preview: ErasurePreview;
}

// ─── billing state (Phase 7) ─────────────────────────────────────────────────

/** One named overage line in a refused downgrade, straight from error.overage —
 *  rendered as rows, never regexed out of the message. The wire format is
 *  final and FLAT: { error: { code, message, overage, from, to } } — there is
 *  no nested detail object. */
export interface PlanOverageRow {
  quota: string;
  label: string;
  used: number;
  limit: number;
  by: number;
}

/** The plan that applies when the current period ends. Distinct from the
 *  current plan — a customer with both sees them side by side. Robust to the
 *  source's `StoredBillingInterval` spelling: the UI displays whatever the
 *  API reports, lowercased, and never invents an effectiveAt it cannot source. */
export interface PendingPlan {
  plan: string;
  interval: string;
  /** Genuinely nullable — read it, never format it when null. */
  effectiveAt: string | null;
}

/** NONE | WARNED | WITHDRAWN. Final, per the API — not a spelling to be
 *  tolerant of. Any non-NONE value means payment recovery is in progress. */
export type DunningStage = "NONE" | "WARNED" | "WITHDRAWN";

// ─── sessions (Phase 7) ──────────────────────────────────────────────────────

/** GET /api/me/sessions — account level, not workspace. */
export interface SessionRow {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  ipAddress: string;
  userAgent: string;
}

// ─── compliance packs & trust center (Phase 7) ───────────────────────────────

/** Issued packs for a client, newest first. */
export interface CompliancePackRow {
  id: string;
  /**
   * The human-quotable document reference, e.g. `DMARC-20261004-ACME-8P1709`.
   *
   * What the public verifier looks a pack up by. Carried here because the API
   * returns it in the list row specifically so a working verify link can be
   * built; passing the row id instead is what made that link 404.
   */
  reference: string;
  hash: string;
  issuedAt: string;
  asOf: string;
  superseded: boolean;
  documentVersion: string;
}

/** POST compliance-packs streams the PDF; these travel in its headers. */
export interface IssuedPackHeaders {
  reference: string;
  sha256: string;
}

// ─── public share report (Phase 7) ───────────────────────────────────────────

/** GET /api/reports/share/:token — the payload a share page renders. Scoped to
 *  the share by the server; nothing in the UI may reach beyond it. */
export interface PublicShareReport {
  sharedFor: { organization: string; client: string; domain: string };
  generatedAt: string;
  expiresAt: string;
  policy: { published: string | null; reportingConfigured: boolean; recommended: string };
  health: {
    score: number | null;
    passRatePercent: number | null;
    messagesObserved: number;
    daysObserved: number;
  };
  reporting: { reportsReceived: number; lastReportAt: string | null; daysSinceLastReport: number | null };
  activity: {
    dailyReports: { date: string; reports: number; messages: number }[];
    spikes: unknown[];
  };
  sources: Array<{
    sourceIp: string;
    failedMessages: number;
    totalMessages: number;
    risk: string;
    topSendingDomain: string | null;
  }>;
  forensic: { included: boolean; reportCount: number; rejectedMessages: number; affectedRecipients: number } | null;
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
  /**
   * The plan that applies when the current period ends — distinct from the
   * current plan, shown side by side. Null means nothing is scheduled. While
   * the field is landing, `undefined` renders the spot without asserting
   * anything, and never a client-side guess.
   */
  pendingPlan?: PendingPlan | null;
  /** NONE | WARNING | WITHDRAWING — how far payment recovery has gone. */
  dunningStage?: DunningStage;
  /** Non-null means the workspace is still working during payment recovery:
   *  say how long is left, because this is the state people email support
   *  about instead of fixing their card. */
  graceEnds?: string | null;
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

// ─── audit trail ──────────────────────────────────────────────────────────────

/**
 * Every value of the API's AuditAction enum, mirrored from
 * apps/api/prisma/schema.prisma. Closed on purpose: listAuditEvents casts the
 * `action` query parameter straight into the Prisma enum with no validation, so
 * a string the database does not recognise is a database error and a 500 rather
 * than a 400. A filter typed against this union cannot carry one.
 */
export type AuditAction =
  | "FORENSIC_IDENTITY_ENABLED"
  | "FORENSIC_IDENTITY_DISABLED"
  | "FORENSIC_PURGE_SINGLE"
  | "FORENSIC_PURGE_DOMAIN"
  | "REPORT_SHARE_CREATED"
  | "REPORT_SHARE_REVOKED"
  | "REPORT_DIGEST_CREATED"
  | "REPORT_DIGEST_UPDATED"
  | "REPORT_DIGEST_DELETED"
  | "ALERT_RULE_CREATED"
  | "ALERT_RULE_UPDATED"
  | "ALERT_RULE_DELETED"
  | "ALERT_ACKNOWLEDGED"
  | "SESSION_REVOKED"
  | "SESSIONS_REVOKED_OTHERS"
  | "SESSIONS_REVOKED_ALL"
  | "PASSWORD_CHANGED"
  | "PLAN_CHANGED"
  | "ENTITLEMENT_OVERRIDE_SET"
  | "ENTITLEMENT_OVERRIDE_REMOVED"
  | "EXPORT_REQUESTED"
  | "EXPORT_DOWNLOADED"
  | "EXPORT_REVOKED"
  | "ERASURE_REQUESTED"
  | "ERASURE_CANCELLED"
  | "ERASURE_COMPLETED"
  | "API_KEY_CREATED"
  | "API_KEY_REVOKED"
  | "CLIENTS_BULK_IMPORTED"
  | "DOMAINS_BULK_IMPORTED"
  | "REFUND_ISSUED"
  | "REFUND_REFUSED"
  | "WEBHOOK_ENDPOINT_CREATED"
  | "WEBHOOK_ENDPOINT_UPDATED"
  | "WEBHOOK_ENDPOINT_DELETED"
  | "WEBHOOK_ENDPOINT_SUSPENDED"
  | "WEBHOOK_ENDPOINT_PROBED"
  | "PORTAL_ACCESS_GRANTED"
  | "PORTAL_ACCESS_REVOKED"
  | "SUBSCRIPTION_UPDATED"
  | "BILLING_CHECKOUT_STARTED"
  | "BILLING_PLAN_CHANGE_REQUESTED"
  | "BILLING_PLAN_CHANGE_REFUSED"
  | "BILLING_CANCELLED"
  | "BILLING_RESUMED"
  | "DPA_ACCEPTED"
  | "TRUST_CENTER_CREATED"
  | "TRUST_CENTER_REVOKED"
  | "COMPLIANCE_PACK_ISSUED"
  | "PAYMENT_FAILED"
  | "BRANDING_UPDATED"
  | "CUSTOM_DOMAIN_VERIFIED"
  | "REPORT_INBOX_CONFIGURED"
  | "REPORT_INBOX_REMOVED"
  | "SSO_CONNECTION_CREATED"
  | "SSO_CONNECTION_REMOVED"
  | "SSO_SIGN_IN";

/**
 * AuditOutcome is SUCCESS or DENIED. There is no FAILED value: the trail records
 * whether an action was permitted, so the two real states are "it happened" and
 * "it was refused". An attempt that threw before the row was written leaves no
 * trace here at all, which is a different gap from a recorded refusal and is
 * why the UI never implies the log is complete.
 */
export type AuditOutcome = "SUCCESS" | "DENIED";

/** Prisma's Json column, as it arrives over the wire. */
export type AuditDetail =
  | string
  | number
  | boolean
  | null
  | AuditDetail[]
  | { [key: string]: AuditDetail };

/**
 * GET /api/workspaces/{organizationId}/audit-events — the response is
 * `{ items }` and nothing else: no hasMore and no nextCursor, because the
 * service takes a limit and ignores the cursor the route parses.
 *
 * `ipAddress` is recorded on the table and deliberately NOT selected by
 * listAuditEvents, so there is nothing here to render. A row that does not show
 * an address is a gap in the read, not a gap in the record.
 *
 * `actorUser` is null when actorUserId is null, and the relation is SetNull on
 * delete, so null means either a platform task or a member who has since been
 * removed. The API cannot tell those apart and neither can this type.
 */
export interface AuditEventRow {
  id: string;
  action: AuditAction;
  outcome: AuditOutcome;
  targetType: string;
  targetId: string | null;
  detail: AuditDetail;
  requestId: string | null;
  createdAt: string;
  domain: { id: string; name: string } | null;
  actorUser: { id: string; name: string; email: string } | null;
}

export interface WorkspaceMemberRow {
  id: string;
  userId: string;
  role: string;
  user?: { id: string; name: string; email: string };
}

/** GET /api/auth/organization/list-invitations — a pending invitation row from
 *  better-auth's organization plugin. */
export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: string;
  status?: string;
  expiresAt?: string | null;
  organizationId?: string;
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
  entryPoint: string;
  clientId: string;
  provisioning: "JIT" | "DISABLED";
  defaultRole: "analyst" | "viewer" | "admin";
  enabled: boolean;
  /** The allowlist of verified email domains a connection is gated on —
   *  surfaced because a connection that silently refuses everyone looks like a
   *  broken feature. */
  allowedEmailDomains: string[];
  createdAt: string;
  /**
   * Where this provider must send the user back to, for both protocols.
   *
   * An administrator configuring an IdP cannot copy a value they were never
   * given. The API computes these and used to throw them away, which is why the
   * settings copy promised a callback URL "shown on the connection after it is
   * created" and then never showed one.
   */
  callbackUrls: { saml: string; oidc: string };
  /**
   * The remaining values an IdP console asks for. `entityId` is ours as the
   * service provider, `idpEntityId` is what the IdP expects to be handed, and
   * `loginUrl` is the entry point a user is sent to. None is a secret, and
   * none is derivable from the callback URL.
   */
  entityId: string;
  idpEntityId: string;
  loginUrl: string;
}

export interface CheckoutRequest {
  plan: string;
  interval: "monthly" | "annual";
  /** Optional by contract: the API falls back to the stored preference when the
   *  request omits it, so a form that forgets the field cannot quote one
   *  currency and charge another. */
  currency?: "USD" | "INR";
  contact: { name: string; email: string; taxId?: string | null };
}

/** GET /billing/currency — the currency a workspace is quoted in, and whether
 *  it can still change. `reason` is the explanation field; never parse the
 *  message for it. */
export interface BillingCurrencyPreference {
  preferredCurrency: "USD" | "INR";
  locked: boolean;
  reason: string | null;
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
  documentVersion: string;
  /** When the facts in the pack were true, not when the PDF was rendered. */
  dataAsOf: string;
  issuedAt: string;
  /**
   * A boolean, not a timestamp: a superseded pack is still fully verifiable, and
   * what changed is that a newer one exists. Reading this as `supersededAt` made
   * every older pack render as current.
   */
  superseded: boolean;
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

/** POST/GET/DELETE /api/workspaces/{id}/portal-access — the agency-side
 *  management surface. The grant is held against an email and activates the
 *  first time that person signs in, covering one client only. */
export interface PortalGrant {
  id: string;
  clientId: string;
  clientName: string;
  email: string;
  displayName: string | null;
  active: boolean;
  bound: boolean;
  firstSeenAt: string | null;
  createdAt: string;
}

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

// ─── DNS scans ────────────────────────────────────────────────────────────────

/** Prisma's ScanRunStatus. RUNNING is the row created before the DNS lookups
 *  start, so a row can legitimately be seen mid-flight. */
export type ScanRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export type ScanLookupStatus = "found" | "missing" | "error";

/** The scanner's own health verdict, which is NOT the same as the row status: a
 *  COMPLETED scan can carry status "missing" when nothing was found, and an
 *  "error" verdict means the DNS lookups ran and found nothing usable. */
export type ScanHealthStatus = "healthy" | "needs_attention" | "missing" | "error";

/** `unknown` is real and load bearing: it is what a domain with no readable
 *  DMARC record scans as, and it must never be rendered as `p=none`. */
export type ScanDmarcPolicy = "none" | "quarantine" | "reject" | "unknown";

export interface ScanDmarcDetail {
  status: ScanLookupStatus;
  record?: string;
  policy: ScanDmarcPolicy;
  tags: Record<string, string>;
  hasAggregateReports: boolean;
  /** A published ruf= address. Without one the API refuses to ingest forensic
   *  reports for the domain, so this is the answer to "why is nothing arriving". */
  hasForensicReports: boolean;
  aggregateMailtoTargets: string[];
  /** Report addresses we cannot receive, because they are web endpoints. */
  aggregateWebTargets: string[];
  error?: string;
}

export interface ScanSpfDetail {
  status: ScanLookupStatus;
  record?: string;
  valid: boolean;
  lookupCount: number;
  error?: string;
}

export interface ScanDkimDetail {
  status: ScanLookupStatus;
  selectors: string[];
  checkedSelectors: string[];
  records: Record<string, string>;
  discoveredVia?: Record<string, string>;
  /** Candidates the lookup budget excluded. Reported so "we checked 25 and gave
   *  up" is never read as "we checked everything". */
  skippedSelectors?: string[];
  error?: string;
}

export interface ScanMxEntry {
  exchange: string;
  priority: number;
}

export interface ScanMxDetail {
  status: ScanLookupStatus;
  records: ScanMxEntry[];
  error?: string;
}

export interface ScanIssue {
  severity: "info" | "warning" | "error";
  code: string;
  title: string;
  message: string;
  recommendation?: string;
}

export interface ScanScoreFactor {
  code: string;
  label: string;
  points: number;
  description: string;
}

export interface ScanScoreBreakdown {
  base: number;
  final: number;
  factors: ScanScoreFactor[];
}

/** The scanner's result, as stored in Scan.result. Null on a row that never got
 *  that far: a FAILED scan records the reason in `error` and nothing else. */
export interface ScanResultPayload {
  domain: string;
  scannedAt: string;
  status: ScanHealthStatus;
  score: number;
  scoreBreakdown: ScanScoreBreakdown;
  dmarc: ScanDmarcDetail;
  spf: ScanSpfDetail;
  dkim: ScanDkimDetail;
  mx: ScanMxDetail;
  issues: ScanIssue[];
  recommendations: string[];
}

/**
 * One row of GET /workspaces/:id/domains/:domainId/scans.
 *
 * The row, not the live DNS answer. A scan is a point-in-time record and this is
 * what was seen then; re-reading it must never be presented as current state.
 * The include carries the domain and the member who asked for it, because a scan
 * is an action somebody took and "who" is part of the evidence.
 */
export interface ScanRow {
  id: string;
  domainId: string;
  requestedById: string | null;
  status: ScanRunStatus;
  score: number | null;
  result: ScanResultPayload | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  domain: {
    id: string;
    name: string;
    status: string;
    client: { id: string; name: string; slug: string };
  };
  requestedBy: { id: string; name: string; email: string } | null;
}

// ─── forensics ────────────────────────────────────────────────────────────────

/**
 * The retention windows the API applies, echoed on the list and both writes.
 * `piiRetentionDays` is the shorter and the more sensitive one: it is the clock
 * on named recipient data, and it is what a legal basis conversation is about.
 */
export interface ForensicRetentionSummary {
  retentionDays: number;
  piiRetentionDays: number;
  redactionVersion: number;
}

export interface ForensicAuthResult {
  type: "DKIM" | "SPF";
  domain?: string;
  selector?: string;
  scope?: string;
  result: string;
}

/**
 * One forensic report, as presentForensic renders it.
 *
 * The identity fields are the whole point of the shape and they have four real
 * states, which must never be collapsed:
 *
 *   recipientAddresses/subjectLine/envelopeFrom present  identities retained and
 *                                                        this caller holds
 *                                                        forensic:identify
 *   piiWithheld === true                                  identities retained,
 *                                                        withheld from this
 *                                                        caller's role
 *   piiRetained === false                                 never stored: the
 *                                                        report arrived with
 *                                                        pseudonyms only
 *
 * The pseudonyms are always present in all three. They are the pseudonymized
 * evidence that survives an identity purge, so a report whose identities are
 * gone is still a report.
 */
export interface ForensicReportRow {
  id: string;
  domainId: string;
  /** Unique per message. Two deliveries of the same report share it, which is
   *  how the API decides a duplicate. */
  fingerprint: string;
  feedbackType: string;
  reportedDomain: string;
  sourceIp: string;
  sourcePort: number | null;
  disposition: string | null;
  deliveryAction: string | null;
  deliveryStatus: string | null;
  dkimResult: string | null;
  spfResult: string | null;
  authResults: ForensicAuthResult[] | null;
  reportingMta: string | null;
  dsnGateway: string | null;
  remoteMta: string | null;
  userAgent: string | null;
  diagnosticCodes: string[] | null;
  recipientCount: number;
  recipientPseudonyms: string[] | null;
  envelopeFromPseudonym: string | null;
  messageIdPseudonym: string | null;
  subjectPseudonym: string | null;
  originalMessageDate: string | null;
  arrivedAt: string | null;
  hasOriginalHeaders: boolean;
  hasOriginalMessageIncluded: boolean;
  piiRetained: boolean;
  recipientAddresses: string[] | null;
  subjectLine: string | null;
  envelopeFrom: string | null;
  redactionVersion: number;
  retentionExpiresAt: string;
  receivedAt: string;
  domain: {
    id: string;
    name: string;
    status: string;
    collectForensicReports: boolean;
    client: { id: string; name: string; slug: string };
  };
  /** At least one identity survived redaction for this report. */
  piiAvailable: boolean;
  /** Identities exist but this caller's role may not read them. */
  piiWithheld?: boolean;
}

/**
 * GET /domains/:domainId/forensics. A page, not an array: the API applies the
 * limit and hands back a cursor, so a list that is treated as complete is a
 * claim the API never made.
 */
export interface ForensicListResponse extends ForensicRetentionSummary {
  items: ForensicReportRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** PATCH /domains/:domainId/forensics — the collection opt in. */
export interface ForensicCollectionSettings {
  domain: {
    id: string;
    name: string;
    collectForensicReports: boolean;
    rufConfigured: boolean;
  };
  retentionDays: number;
  piiRetentionDays: number;
  redactionVersion: number;
}

/**
 * PATCH /domains/:domainId/forensics/identities.
 *
 * `purgedIdentities` is the count of reports whose stored recipient addresses,
 * subject lines and envelope senders were destroyed by this call. It is the
 * number the confirmation promised, so it is rendered rather than summarised.
 */
export interface ForensicIdentitySettings extends ForensicRetentionSummary {
  domain: {
    id: string;
    name: string;
    collectForensicReports: boolean;
    retainForensicPii: boolean;
    rufConfigured: boolean;
    forensicPiiEnabledAt: string | null;
  };
  purgedIdentities: number;
}

/** POST /domains/:domainId/forensics — 201 when stored, 200 when a duplicate. */
export interface ForensicIngestResult {
  duplicate: boolean;
  forensic: ForensicReportRow;
}

/** DELETE /domains/:domainId/forensics — the whole domain's forensic rows. */
export interface ForensicPurgeResult {
  deleted: number;
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
    /** PLAN_CHANGE_OVER_QUOTA carries named overages directly on the error —
     *  the wire format is flat ({ error: { code, message, overage, from, to } }),
     *  rendered as rows. The message stays the headline, and nothing is ever
     *  regexed out of a sentence. */
    overage?: PlanOverageRow[];
    from?: string;
    to?: string;
    /**
     * set on the 400 the identity route answers when a named-recipient purge
     * was asked for without `confirmNamePurge`. The flag is what tells the UI
     * the refusal is about the confirmation rather than about the request being
     * malformed, so it can offer the confirmation instead of quoting an error.
     */
    requiresNamePurgeConfirmation?: boolean;
  };
}
