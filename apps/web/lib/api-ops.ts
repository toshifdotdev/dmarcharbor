/**
 * api-ops.ts — Phase 3 server-side operations: alerts, digests, settings,
 * billing. All calls are session-cookie forwarded like lib/api.ts.
 *
 * Staff-only endpoints (POST /billing/reconcile, PATCH /workspaces/:id/plan,
 * PATCH/POST/DELETE /workspaces/:id/entitlement-overrides) are deliberately
 * ABSENT: they are authorised by a deployment secret, no user can reach them,
 * and they have no interface. If a screen seems to need one, the screen is
 * wrong — report it instead of adding a call here.
 *
 * N+1 NOTE: nothing here fans out per-domain. Bulk signals collapse at
 * lib/api.ts::getAllDomainSignals when the bulk endpoint lands.
 */

import { API_BASE, apiFetch } from "./api-fetch";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type {
  AlertEventRow,
  AlertRuleRow,
  ApiErrorBody,
  ApiKeyRow,
  AuditAction,
  AuditEventRow,
  BillingStatus,
  BillingCurrencyPreference,
  BrandingSettings,
  PortalBranding,
  CheckoutRequest,
  CheckoutSummary,
  CreatedShare,
  DnsChangePage,
  DnsConnectionRow,
  DomainRow,
  DomainSwitchView,
  ErasureCreated,
  ErasurePreview,
  ErasureRequestRow,
  ExportJob,
  ForensicListResponse,
  ForensicReportRow,
  HostedBimiView,
  HostedDmarcView,
  HostedMtaStsView,
  IssuedApiKey,
  MailboxComplianceView,
  SubdomainDiscovery,
  ManagedSpfView,
  MonthlyReportRow,
  MonthlyReportSchedule,
  MySecurity,
  PlanDefinition,
  PsaJobView,
  PsaMappingView,
  PsaView,
  PortalGrant,
  ReportDigestRow,
  ReportInboxSettings,
  ReportShareRow,
  ResolvedEntitlements,
  ScanRow,
  ScanPage,
  SlackDestination,
  SsoConnectionRow,
  TeamsDestination,
  TeamsTestResult,
  TlsReportPage,
  TlsReportSummary,
  DomainRegistrationView,
  ProspectReportRow,
  ProspectUsage,
  DomainPolicyProposals,
  TrustSlugStatus,
  VerifyDomainResult,
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhookEventName,
  WorkspaceInvitation,
  WorkspaceMemberRow,
  WorkspaceSecurity,
  PageEnvelope,
} from "./types";


export class OpsError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly feature: string | undefined;
  readonly body: ApiErrorBody["error"] | undefined;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error?.message ?? `API request failed (${status})`);
    this.name = "OpsError";
    this.status = status;
    this.code = body?.error?.code;
    this.feature = body?.error?.feature;
    this.body = body?.error;
  }
}

async function opsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const jar = await cookies();
  const header = new Headers(init?.headers);
  header.set("content-type", "application/json");
  const session = jar.get("better-auth.session_token");
  if (session) header.set("cookie", `better-auth.session_token=${session.value}`);

  const res = await apiFetch(`${API_BASE}${path}`, {
    ...init,
    headers: header,
    cache: "no-store",
    credentials: "include",
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T & ApiErrorBody) : null;
  /**
   * A workspace that requires two-step verification refuses every workspace
   * route until this account enrols. Sending the person to the account screen is
   * the only useful answer; rendering a generic permission error would leave
   * them with no control that fixes it.
   */
  if (res.status === 403 && (body as ApiErrorBody | null)?.error?.code === "MFA_REQUIRED") {
    redirect("/account/security?required=1");
  }
  if (!res.ok) throw new OpsError(res.status, (body as ApiErrorBody) ?? null);
  return body as T;
}

// ─── billing & entitlements ──────────────────────────────────────────────────

/** GET /api/me/security — account level, deliberately not workspace scoped so
 *  the workspace MFA gate can never make the page that fixes it unreachable. */
export function getMySecurity(): Promise<MySecurity> {
  return opsFetch<MySecurity>("/api/me/security");
}

/** GET /api/workspaces/:id/security — the workspace requirement and how many
 *  non-portal members still have to enrol. */
export function getWorkspaceSecurity(organizationId: string): Promise<WorkspaceSecurity> {
  return opsFetch<WorkspaceSecurity>(`/api/workspaces/${organizationId}/security`);
}

export function getWorkspaceEntitlements(
  organizationId: string,
): Promise<ResolvedEntitlements> {
  return opsFetch<ResolvedEntitlements>(
    `/api/workspaces/${organizationId}/entitlements`,
  );
}

/** GET /mailbox-compliance — Gmail, Yahoo and Outlook requirements from evidence already held. */
export function getMailboxCompliance(
  organizationId: string,
  domainId: string,
): Promise<MailboxComplianceView> {
  return opsFetch<MailboxComplianceView>(
    `/api/workspaces/${organizationId}/domains/${domainId}/mailbox-compliance`,
  );
}

/** GET /subdomains — names below this domain seen sending in its reports and not monitored. */
export function getSubdomains(
  organizationId: string,
  domainId: string,
): Promise<SubdomainDiscovery> {
  return opsFetch<SubdomainDiscovery>(
    `/api/workspaces/${organizationId}/domains/${domainId}/subdomains`,
  );
}

/** GET /hosted-dmarc — availability, the CNAME and the served value. */
export function getHostedDmarc(
  organizationId: string,
  domainId: string,
): Promise<HostedDmarcView> {
  return opsFetch<HostedDmarcView>(
    `/api/workspaces/${organizationId}/domains/${domainId}/hosted-dmarc`,
  );
}

/** GET /managed-spf — availability, sources and what we publish. */
export function getManagedSpf(
  organizationId: string,
  domainId: string,
): Promise<ManagedSpfView> {
  return opsFetch<ManagedSpfView>(
    `/api/workspaces/${organizationId}/domains/${domainId}/managed-spf`,
  );
}

/** GET /hosted-bimi — availability, the CNAME, the logo and the certificate. */
export function getHostedBimi(
  organizationId: string,
  domainId: string,
): Promise<HostedBimiView> {
  return opsFetch<HostedBimiView>(
    `/api/workspaces/${organizationId}/domains/${domainId}/hosted-bimi`,
  );
}

/** GET /hosted-mta-sts — the two CNAMEs, the policy we serve and its readiness. */
export function getHostedMtaSts(
  organizationId: string,
  domainId: string,
): Promise<HostedMtaStsView> {
  return opsFetch<HostedMtaStsView>(
    `/api/workspaces/${organizationId}/domains/${domainId}/hosted-mta-sts`,
  );
}

/** GET /psa — the connection, its health and what was skipped. */
export function getPsa(organizationId: string): Promise<PsaView> {
  return opsFetch<PsaView>(`/api/workspaces/${organizationId}/psa`);
}

/** GET /psa/mappings — every client, with its company or null. */
export function getPsaMappings(
  organizationId: string,
): Promise<{ mappings: PsaMappingView[] }> {
  return opsFetch<{ mappings: PsaMappingView[] }>(
    `/api/workspaces/${organizationId}/psa/mappings`,
  );
}

/** GET /psa/jobs — the outbox, newest first. */
export function getPsaJobs(
  organizationId: string,
  limit = 50,
): Promise<{ jobs: PsaJobView[] }> {
  return opsFetch<{ jobs: PsaJobView[] }>(
    `/api/workspaces/${organizationId}/psa/jobs?limit=${limit}`,
  );
}

/** GET /tls-reports/summary — totals, breakdowns and the record state. */
export function getTlsReportSummary(
  organizationId: string,
  domainId: string,
  days = 30,
): Promise<TlsReportSummary> {
  return opsFetch<TlsReportSummary>(
    `/api/workspaces/${organizationId}/domains/${domainId}/tls-reports/summary?days=${days}`,
  );
}

/** GET /prospect-reports — the workspace's prospect reports and this month's usage. */
export function listProspectReports(
  organizationId: string,
): Promise<{ reports: ProspectReportRow[]; usage: ProspectUsage }> {
  return opsFetch<{ reports: ProspectReportRow[]; usage: ProspectUsage }>(
    `/api/workspaces/${organizationId}/prospect-reports`,
  );
}

/** GET /policy-proposals — requests for the client to approve a stricter policy. */
export function getPolicyProposals(organizationId: string, domainId: string): Promise<DomainPolicyProposals> {
  return opsFetch<DomainPolicyProposals>(
    `/api/workspaces/${organizationId}/domains/${domainId}/policy-proposals`,
  );
}

/** GET /registration — the registration expiry, or null before the first lookup. */
export function getDomainRegistration(
  organizationId: string,
  domainId: string,
): Promise<{ registration: DomainRegistrationView | null }> {
  return opsFetch<{ registration: DomainRegistrationView | null }>(
    `/api/workspaces/${organizationId}/domains/${domainId}/registration`,
  );
}

/** GET /tls-reports — the first page of TLS-RPT reports. */
export function getTlsReports(
  organizationId: string,
  domainId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<TlsReportPage> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor) query.set("cursor", options.cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return opsFetch<TlsReportPage>(
    `/api/workspaces/${organizationId}/domains/${domainId}/tls-reports${suffix}`,
  );
}

/** GET /dns-connections — never includes a token, only its last four characters. */
export function getDnsConnections(
  organizationId: string,
): Promise<{ connections: DnsConnectionRow[] }> {
  return opsFetch<{ connections: DnsConnectionRow[] }>(
    `/api/workspaces/${organizationId}/dns-connections`,
  );
}

export function getBillingStatus(organizationId: string): Promise<BillingStatus> {
  return opsFetch<BillingStatus>(`/api/workspaces/${organizationId}/billing`);
}

/** GET /billing/currency — the currency a workspace is quoted in and whether
 *  it can still change. Default is INR until Paddle is approved. */
export function getBillingCurrency(
  organizationId: string,
): Promise<BillingCurrencyPreference> {
  return opsFetch<BillingCurrencyPreference>(
    `/api/workspaces/${organizationId}/billing/currency`,
  );
}

/** The full plan catalog with prices as integer minor units. The only source
 *  of plan names and prices — never hardcoded in a component. */
export function getPlanCatalog(): Promise<{ plans: PlanDefinition[]; order: string[] }> {
  return opsFetch<{ plans: PlanDefinition[]; order: string[] }>("/api/plans");
}

/** GET /api/capabilities: what this deployment can actually DO. The currencies
 *  list is the set a checkout can complete (provider readiness, not a flag),
 *  so a page quoting a currency from here can never promise a payment the API
 *  refuses. Unauthenticated and public. */
export interface DeploymentCapabilities {
  currencies: string[];
  defaultCurrency: string;
  providers: { razorpay: boolean; paddle: boolean };
  /** A demonstration reference, shaped like a real one and matching no pack. */
  compliancePack?: { exampleReference: string; exampleFilename: string };
}
export function getCapabilities(): Promise<DeploymentCapabilities> {
  return opsFetch<DeploymentCapabilities>("/api/capabilities");
}

export function startCheckout(
  organizationId: string,
  body: CheckoutRequest,
): Promise<CheckoutSummary> {
  return opsFetch<CheckoutSummary>(
    `/api/workspaces/${organizationId}/billing/checkout`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function changeBillingPlan(
  organizationId: string,
  body: { plan: string; interval?: "monthly" | "annual"; currency?: "USD" | "INR" },
): Promise<{ status: "scheduled" | "applied" | "cancelling"; effectiveAt: string; effectiveDate?: string | null }> {
  // MOORING answers "cancelling"; otherwise "applied" (Paddle, at once) or
  // "scheduled" (Razorpay, at period end).
  return opsFetch<{ status: "scheduled" | "applied" | "cancelling"; effectiveAt: string; effectiveDate?: string | null }>(
    `/api/workspaces/${organizationId}/billing/plan`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
}

export function cancelSubscription(
  organizationId: string,
): Promise<{ status: "cancelling"; accessUntil: string | null }> {
  return opsFetch<{ status: "cancelling"; accessUntil: string | null }>(
    `/api/workspaces/${organizationId}/billing/cancel`,
    { method: "POST" },
  );
}

export function resumeSubscription(
  organizationId: string,
): Promise<{ status: "active" }> {
  return opsFetch<{ status: "active" }>(
    `/api/workspaces/${organizationId}/billing/resume`,
    { method: "POST" },
  );
}

export function openBillingPortal(
  organizationId: string,
): Promise<{ url: string }> {
  return opsFetch<{ url: string }>(
    `/api/workspaces/${organizationId}/billing/portal`,
    { method: "POST" },
  );
}

// ─── alerts ──────────────────────────────────────────────────────────────────

export function listAlertRules(
  organizationId: string,
  limit = 50,
): Promise<PageEnvelope<AlertRuleRow>> {
  return opsFetch<PageEnvelope<AlertRuleRow>>(
    `/api/workspaces/${organizationId}/alert-rules?limit=${limit}`,
  );
}

export function listAlertEvents(
  organizationId: string,
  limit = 50,
): Promise<PageEnvelope<AlertEventRow>> {
  return opsFetch<PageEnvelope<AlertEventRow>>(
    `/api/workspaces/${organizationId}/alerts?limit=${limit}`,
  );
}

/** Required fields per the API contract (alertRuleCreateSchema). All nine. */
export interface AlertRuleCreate {
  domainId: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  maxReminderLevel: number;
  recipientUserIds: string[];
}

export function createAlertRule(
  organizationId: string,
  body: AlertRuleCreate,
): Promise<AlertRuleRow> {
  return opsFetch<AlertRuleRow>(
    `/api/workspaces/${organizationId}/alert-rules`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function updateAlertRule(
  organizationId: string,
  ruleId: string,
  body: Partial<AlertRuleCreate> & { enabled?: boolean },
): Promise<AlertRuleRow> {
  return opsFetch<AlertRuleRow>(
    `/api/workspaces/${organizationId}/alert-rules/${ruleId}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export function deleteAlertRule(
  organizationId: string,
  ruleId: string,
): Promise<void> {
  return opsFetch<void>(
    `/api/workspaces/${organizationId}/alert-rules/${ruleId}`,
    { method: "DELETE" },
  );
}

export function acknowledgeAlert(
  organizationId: string,
  eventId: string,
): Promise<{ acknowledged: boolean }> {
  return opsFetch<{ acknowledged: boolean }>(
    `/api/workspaces/${organizationId}/alerts/${eventId}/acknowledge`,
    { method: "POST" },
  );
}

// ─── audit trail ──────────────────────────────────────────────────────────────

/**
 * GET /audit-events — the append-only trail, newest first.
 *
 * READ ONLY, and deliberately so. The service exposes no update and no delete,
 * and the operations suite asserts both answer 404: a row that can be edited is
 * not evidence. Nothing in this file may grow a write against this route.
 *
 * The response is `{ items }` with no hasMore and no nextCursor. The route parses
 * a cursor out of the query and then never passes it to the service, so this is
 * the newest `limit` rows and the way to reach anything older is a narrower
 * filter, never a next page.
 *
 * `action` is typed as AuditAction because the API casts the raw query string
 * into the Prisma enum without validating it: an unknown value is a database
 * error and a 500, not a 400. Only real enum values may be sent.
 *
 * `domainId` is omitted rather than sent empty. Prisma treats `domainId: ''` as
 * a real filter for a domain whose id is the empty string, so a cleared filter
 * would quietly return nothing at all.
 */
export interface AuditEventQuery {
  domainId?: string;
  action?: AuditAction;
  limit?: number;
  /**
   * Restrict to the last N hours.
   *
   * Undefined means no restriction, and it is omitted rather than sent: the API
   * reads a missing `withinHours` as "every event", so sending 0 to mean the same
   * thing would be a lie the reader has to know to ignore.
   */
  withinHours?: number;
}

/** What the API clamps `limit` to (apps/api/src/services/audit.service.ts). */
export const AUDIT_LIMIT_MIN = 1;
export const AUDIT_LIMIT_MAX = 200;
/** The service's own default when the query carries no limit. */
export const AUDIT_LIMIT_DEFAULT = 100;

export function listAuditEvents(
  organizationId: string,
  options: AuditEventQuery = {},
): Promise<{ items: AuditEventRow[] }> {
  const query = new URLSearchParams();
  if (options.domainId) query.set("domainId", options.domainId);
    if (options.action) query.set("action", options.action);
    if (options.withinHours) query.set("withinHours", String(options.withinHours));

  query.set(
    "limit",
    String(
      Math.min(
        Math.max(options.limit ?? AUDIT_LIMIT_DEFAULT, AUDIT_LIMIT_MIN),
        AUDIT_LIMIT_MAX,
      ),
    ),
  );
  return opsFetch<{ items: AuditEventRow[] }>(
    `/api/workspaces/${organizationId}/audit-events?${query.toString()}`,
  );
}

// ─── DNS scans ─────────────────────────────────────────────────────────────────

/**
 * GET /domains/:domainId/scans — the scan history for one domain, newest first.
 *
 * A bare array, not a page. The route has no limit, no cursor and no offset, so
 * this is every scan the workspace has run against the domain. It is a history,
 * never a claim about current DNS: only the newest row describes the domain as
 * it was at that moment.
 *
 * NO ENTITLEMENT, and that is read from the route rather than assumed.
 * domain-scan.routes.ts carries requireSession plus
 * requireOrganizationPermission('domain', 'update') for the POST and
 * ('domain', 'read') for both reads, and nothing else. There is no
 * requireFeature on any of the three and no scan key exists in
 * plan-catalog.ts's EntitlementKey union, so gating this call on any feature
 * would hide a control every plan's API answers.
 */
export function listDomainScans(
  organizationId: string,
  domainId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ScanPage> {
  const query = new URLSearchParams();
  query.set("limit", String(Math.min(Math.max(options.limit ?? 50, 1), 100)));
  if (options.cursor) query.set("cursor", options.cursor);
  return opsFetch<ScanPage>(
    `/api/workspaces/${organizationId}/domains/${domainId}/scans?${query.toString()}`,
  );
}

/** GET /clients/:clientId/monthly-reports — at most 24, newest first. */
export function listMonthlyReports(
  organizationId: string,
  clientId: string,
): Promise<{ reports: MonthlyReportRow[] }> {
  return opsFetch<{ reports: MonthlyReportRow[] }>(
    `/api/workspaces/${organizationId}/clients/${clientId}/monthly-reports`,
  );
}

/** GET /clients/:clientId/monthly-report-schedule — null until one is saved. */
export function getMonthlyReportSchedule(
  organizationId: string,
  clientId: string,
): Promise<{ schedule: MonthlyReportSchedule | null }> {
  return opsFetch<{ schedule: MonthlyReportSchedule | null }>(
    `/api/workspaces/${organizationId}/clients/${clientId}/monthly-report-schedule`,
  );
}

/**
 * GET /domains/:domainId/dns-changes — the history of what changed between
 * completed scans. Newest first, paginated, with a repeatable severity filter.
 */
export function getDnsChanges(
  organizationId: string,
  domainId: string,
  options: { limit?: number; cursor?: string; severity?: string[] } = {},
): Promise<DnsChangePage> {
  const query = new URLSearchParams();
  query.set("limit", String(Math.min(Math.max(options.limit ?? 50, 1), 100)));
  if (options.cursor) query.set("cursor", options.cursor);
  for (const severity of options.severity ?? []) query.append("severity", severity);
  return opsFetch<DnsChangePage>(
    `/api/workspaces/${organizationId}/domains/${domainId}/dns-changes?${query.toString()}`,
  );
}

/**
 * GET /domains/:domainId/switch — the provider switch for one domain.
 *
 * No DNS is read here: the response is the stored state plus the overlap
 * computed from reports already held. A switch that has never been planned
 * answers `{ switch: null, eligible }`, where eligible says whether the stored
 * DMARC record still sends reports somewhere other than us.
 */
export function getDomainSwitch(
  organizationId: string,
  domainId: string,
): Promise<DomainSwitchView> {
  return opsFetch<DomainSwitchView>(
    `/api/workspaces/${organizationId}/domains/${domainId}/switch`,
  );
}

/**
 * GET /scans/:scanId — one scan, in the workspace. Not gated on the domain, so
 * a scan id is enough to reach the row it belongs to.
 */
export function getDomainScan(
  organizationId: string,
  scanId: string,
): Promise<ScanRow> {
  return opsFetch<ScanRow>(`/api/workspaces/${organizationId}/scans/${scanId}`);
}

/**
 * POST /domains/:domainId/scans — runs the authenticated scan now.
 *
 * Synchronous: the call resolves after the DNS lookups finish, so a 201 means
 * the scan completed and the domain row has already been rewritten with the
 * policy, score, SPF record, DKIM selectors and MX records it found. That write
 * is the only place `domain.dmarcPolicy` is ever set, which is why this exists
 * as a control at all.
 *
 * Three refusals are real answers rather than failures:
 *   409 the domain is not VERIFIED, so there is nothing to scan
 *   502 the scan ran and failed; the FAILED row is in the body alongside the error
 *   429 twenty scans a minute, from scanRateLimiter
 */
export function createDomainScan(
  organizationId: string,
  domainId: string,
): Promise<ScanRow> {
  return opsFetch<ScanRow>(
    `/api/workspaces/${organizationId}/domains/${domainId}/scans`,
    { method: "POST" },
  );
}

// ─── forensics ────────────────────────────────────────────────────────────────

/**
 * GET /domains/:domainId/forensics — the forensic reports held for one domain,
 * newest first, with the retention windows the API applies.
 *
 * There is NO workspace-wide list. Every forensic route is scoped to a domain
 * (or to one report id), so a workspace-level index would have to fan out one
 * request per domain and would silently truncate at this page size for each.
 * That is why the forensics section is per domain: it is the shape the API has.
 *
 * Gated by the API on requireFeature('reports.forensic') and
 * requireOrganizationPermission('forensic', 'read'), so a 402 here is a plan
 * answer and a 403 is a role answer. Both are real states and neither is an
 * empty list: OpsError carries the status for the caller to tell them apart.
 */
export function listDomainForensics(
  organizationId: string,
  domainId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ForensicListResponse> {
  const query = new URLSearchParams();
  // Clamped here to the API's own bounds (utils/pagination.ts) so a hand-edited
  // page size cannot turn into a request the API answers with a 400.
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  query.set("limit", String(limit));
  if (options.cursor) query.set("cursor", options.cursor);
  return opsFetch<ForensicListResponse>(
    `/api/workspaces/${organizationId}/domains/${domainId}/forensics?${query.toString()}`,
  );
}

/**
 * GET /forensics/:forensicId — one report, read on demand.
 *
 * Carries no requireFeature, unlike the list. A workspace whose plan no longer
 * carries reports.forensic can therefore still open a single report it already
 * holds, which is the API's decision and not one this app second-guesses.
 */
export function getForensicReport(
  organizationId: string,
  forensicId: string,
): Promise<ForensicReportRow> {
  return opsFetch<ForensicReportRow>(
    `/api/workspaces/${organizationId}/forensics/${forensicId}`,
  );
}

// ─── digests ─────────────────────────────────────────────────────────────────

export function listReportDigests(
  organizationId: string,
  limit = 50,
): Promise<PageEnvelope<ReportDigestRow>> {
  return opsFetch<PageEnvelope<ReportDigestRow>>(
    `/api/workspaces/${organizationId}/report-digests?limit=${limit}`,
  );
}

/**
 * Digest creation, per the API contract: frequency (not cadence), dayOfMonth
 * capped at 28 on purpose (every month has a 28th), recipientEmails 1-20.
 * includeForensics may only be set on a plan with reports.forensic — the API
 * enforces it; the UI offers it behind the same entitlement check.
 */
export interface ReportDigestCreate {
  domainId: string;
  frequency: "WEEKLY" | "MONTHLY";
  sendHourUtc: number;
  weekday: number;
  dayOfMonth: number;
  recipientEmails: string[];
  includeForensics: boolean;
}

export function createReportDigest(
  organizationId: string,
  body: ReportDigestCreate,
): Promise<ReportDigestRow> {
  return opsFetch<ReportDigestRow>(
    `/api/workspaces/${organizationId}/report-digests`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function updateReportDigest(
  organizationId: string,
  digestId: string,
  body: Partial<ReportDigestCreate> & { enabled?: boolean },
): Promise<ReportDigestRow> {
  return opsFetch<ReportDigestRow>(
    `/api/workspaces/${organizationId}/report-digests/${digestId}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export function deleteReportDigest(
  organizationId: string,
  digestId: string,
): Promise<void> {
  return opsFetch<void>(
    `/api/workspaces/${organizationId}/report-digests/${digestId}`,
    { method: "DELETE" },
  );
}

// ─── settings: members, branding, mailbox, SSO ───────────────────────────────

// ─── settings: webhooks ───────────────────────────────────────────────────────

/**
 * GET /webhooks — the endpoint list, plus the event catalogue and the events
 * the API subscribes by default.
 *
 * `events` is returned by the API rather than hardcoded here, so the checkboxes
 * are always exactly what the backend will accept. `defaultEvents` exists for
 * the same reason: the API decided that report.received is opt in because a
 * large agency gets hundreds a day, and the create form must start from that
 * decision instead of re-making it.
 *
 * The signing secret is never in this response.
 */
export function listWebhookEndpoints(
  organizationId: string,
): Promise<{
  endpoints: WebhookEndpointRow[];
  events: WebhookEventName[];
  defaultEvents: WebhookEventName[];
}> {
  return opsFetch<{
    endpoints: WebhookEndpointRow[];
    events: WebhookEventName[];
    defaultEvents: WebhookEventName[];
  }>(`/api/workspaces/${organizationId}/webhooks`);
}

/**
 * GET /webhook-deliveries — the delivery log, newest first, capped at 50 by the
 * API. Passing endpointId narrows it to one endpoint, which is how the page
 * answers "is this specific integration healthy" without a client side filter
 * that could hide a row.
 */
export function listWebhookDeliveries(
  organizationId: string,
  endpointId?: string,
): Promise<{ deliveries: WebhookDeliveryRow[] }> {
  const query = endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : "";
  return opsFetch<{ deliveries: WebhookDeliveryRow[] }>(
    `/api/workspaces/${organizationId}/webhook-deliveries${query}`,
  );
}

// ─── settings sections (Phase 6) ─────────────────────────────────────────────

/** Slack alerts. The webhook URL NEVER comes back from the API — maskedUrl is
 *  the host plus its last four characters. There is nothing to fetch to
 *  populate an edit form: editing means the owner pastes a new URL, and the
 *  PUT accepts it. */
export function getSlackDestination(
  organizationId: string,
): Promise<SlackDestination | null> {
  return opsFetch<SlackDestination | null>(
    `/api/workspaces/${organizationId}/slack-destination`,
  );
}

export function setSlackDestination(
  organizationId: string,
  body: { webhookUrl: string; channelLabel?: string | null },
): Promise<SlackDestination> {
  return opsFetch<SlackDestination>(
    `/api/workspaces/${organizationId}/slack-destination`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function setSlackDestinationEnabled(
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  return opsFetch<void>(`/api/workspaces/${organizationId}/slack-destination`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function deleteSlackDestination(organizationId: string): Promise<void> {
  return opsFetch<void>(`/api/workspaces/${organizationId}/slack-destination`, {
    method: "DELETE",
  });
}

/** Microsoft Teams alerts. Same rule as Slack: the Workflows address never
 *  comes back, so the page shows maskedUrl and editing means pasting a new
 *  one. */
export function getTeamsDestination(
  organizationId: string,
): Promise<TeamsDestination | null> {
  return opsFetch<TeamsDestination | null>(
    `/api/workspaces/${organizationId}/teams-destination`,
  );
}

export function setTeamsDestination(
  organizationId: string,
  body: { webhookUrl: string; channelLabel?: string | null },
): Promise<TeamsDestination> {
  return opsFetch<TeamsDestination>(
    `/api/workspaces/${organizationId}/teams-destination`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function setTeamsDestinationEnabled(
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  return opsFetch<void>(`/api/workspaces/${organizationId}/teams-destination`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function deleteTeamsDestination(organizationId: string): Promise<void> {
  return opsFetch<void>(`/api/workspaces/${organizationId}/teams-destination`, {
    method: "DELETE",
  });
}

export function testTeamsDestination(
  organizationId: string,
): Promise<TeamsTestResult> {
  return opsFetch<TeamsTestResult>(
    `/api/workspaces/${organizationId}/teams-destination/test`,
    { method: "POST" },
  );
}

/** API keys. `key` appears in the create response EXACTLY ONCE — the list only
 *  ever carries prefixes. */
export function listApiKeys(
  organizationId: string,
): Promise<{ apiKeys: ApiKeyRow[] }> {
  return opsFetch<{ apiKeys: ApiKeyRow[] }>(
    `/api/workspaces/${organizationId}/api-keys`,
  );
}

export function createApiKey(
  organizationId: string,
  body: {
    name: string;
    scopes: Array<"read" | "write">;
    expiresInDays?: number;
  },
): Promise<IssuedApiKey> {
  return opsFetch<IssuedApiKey>(`/api/workspaces/${organizationId}/api-keys`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function revokeApiKey(
  organizationId: string,
  keyId: string,
): Promise<void> {
  return opsFetch<void>(
    `/api/workspaces/${organizationId}/api-keys/${keyId}`,
    { method: "DELETE" },
  );
}

/** Data export is a REQUEST: created first, then available at its downloadUrl
 *  until it expires. */
export function createExport(
  organizationId: string,
  body: {
    scope: "ORGANIZATION" | "CLIENT" | "DOMAIN";
    targetId?: string;
    format: "JSON" | "CSV";
  },
): Promise<ExportJob> {
  return opsFetch<ExportJob>(`/api/workspaces/${organizationId}/exports`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listExports(organizationId: string): Promise<{
  exports: ExportJob[];
  linkDays: number;
  recordRetentionDays: number;
}> {
  return opsFetch(`/api/workspaces/${organizationId}/exports`);
}

export function deleteExport(
  organizationId: string,
  exportId: string,
): Promise<void> {
  return opsFetch<void>(
    `/api/workspaces/${organizationId}/exports/${exportId}`,
    { method: "DELETE" },
  );
}

/** Erasure is destructive and irreversible. The preview reports exactly what
 *  a request would do before anything happens, and the request itself enters a
 *  grace period (202, state PENDING) before deletion. */
export function previewErasure(
  organizationId: string,
  scope: "ORGANIZATION" | "CLIENT" | "DOMAIN",
  targetId?: string,
): Promise<ErasurePreview> {
  const q = targetId ? `&targetId=${encodeURIComponent(targetId)}` : "";
  return opsFetch<ErasurePreview>(
    `/api/workspaces/${organizationId}/erasures/preview?scope=${scope}${q}`,
  );
}

export function createErasure(
  organizationId: string,
  body: {
    scope: "ORGANIZATION" | "CLIENT" | "DOMAIN";
    targetId?: string;
    reason?: string;
  },
): Promise<ErasureCreated> {
  return opsFetch<ErasureCreated>(`/api/workspaces/${organizationId}/erasures`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listErasures(organizationId: string): Promise<{
  requests: ErasureRequestRow[];
  certificateRetentionDays: number;
}> {
  return opsFetch(`/api/workspaces/${organizationId}/erasures`);
}

export function cancelErasure(
  organizationId: string,
  erasureId: string,
): Promise<void> {
  return opsFetch<void>(
    `/api/workspaces/${organizationId}/erasures/${erasureId}/cancel`,
    { method: "POST" },
  );
}

export function listWorkspaceMembers(
  organizationId: string,
): Promise<{ members: WorkspaceMemberRow[] }> {
  return opsFetch<{ members: WorkspaceMemberRow[] }>(
    `/api/workspaces/${organizationId}/members`,
  );
}

/**
 * GET /api/workspaces/:id/dpa-acceptance — what this workspace has agreed to,
 * and whether what it agreed to is still what the business publishes.
 *
 * Read on every screen through the Shell, and the only reason the re-consent
 * banner can exist. Until the API enforced `requiresReconsent` the flag had no
 * consumer at all, so a revised agreement changed nothing for anybody; now that
 * it blocks workspace requests, this read is what tells the reader there is
 * something to accept instead of leaving them at a 409 with no explanation.
 */
export function getDpaAcceptance(
  organizationId: string,
): Promise<{
  accepted: boolean;
  version: string | null;
  currentVersion: string;
  requiresReconsent: boolean;
}> {
  return opsFetch<{
    accepted: boolean;
    version: string | null;
    currentVersion: string;
    requiresReconsent: boolean;
  }>(`/api/workspaces/${organizationId}/dpa-acceptance`);
}

/** GET /api/auth/organization/list-invitations — the pending invitations for
 *  a workspace, straight from the organization plugin that created them. */
export function listPendingInvitations(
  organizationId: string,
): Promise<WorkspaceInvitation[]> {
  return opsFetch<WorkspaceInvitation[]>(
    `/api/auth/organization/list-invitations?organizationId=${encodeURIComponent(organizationId)}`,
  );
}

export function getBranding(
  organizationId: string,
): Promise<BrandingSettings> {
  return opsFetch<BrandingSettings>(`/api/workspaces/${organizationId}/branding`);
}

/** GET /branding/resolved — what a client actually gets: the logo only when it
 *  is a platform-served object and the plan carries white label, colours only
 *  under that licence. Same shape as the portal's PortalBranding. */
export function getResolvedBranding(organizationId: string): Promise<PortalBranding> {
  return opsFetch<PortalBranding>(`/api/workspaces/${organizationId}/branding/resolved`);
}

export function setCustomDomain(
  organizationId: string,
  customDomain: string | null,
): Promise<{
  customDomain: string | null;
  verificationHost: string | null;
  verificationValue: string | null;
  notice: string;
}> {
  return opsFetch<{
    customDomain: string | null;
    verificationHost: string | null;
    verificationValue: string | null;
    notice: string;
  }>(`/api/workspaces/${organizationId}/branding/custom-domain`, {
    method: "PUT",
    body: JSON.stringify({ customDomain }),
  });
}

export function verifyCustomDomain(
  organizationId: string,
): Promise<{ verified: boolean; lookupStatus: string; error?: string }> {
  return opsFetch<{ verified: boolean; lookupStatus: string; error?: string }>(
    `/api/workspaces/${organizationId}/branding/custom-domain/verify`,
    { method: "POST" },
  );
}

/** Step 1 of the logo upload flow: request the presigned URL. */
export function requestLogoUpload(
  organizationId: string,
  body: { contentType: string; byteSize: number },
): Promise<{ uploadUrl: string; objectKey: string; [k: string]: unknown }> {
  return opsFetch(`/api/workspaces/${organizationId}/branding/logo/upload`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Step 3 of the logo upload flow: confirm the objectKey the PUT returned.
 *  The objectKey must be inside this workspace's prefix — the API rejects
 *  anything else, and the UI never constructs one. */
export function confirmLogoUpload(
  organizationId: string,
  objectKey: string,
): Promise<BrandingSettings> {
  return opsFetch<BrandingSettings>(
    `/api/workspaces/${organizationId}/branding/logo/confirm`,
    { method: "POST", body: JSON.stringify({ objectKey }) },
  );
}

export function getReportInbox(
  organizationId: string,
): Promise<ReportInboxSettings> {
  return opsFetch<ReportInboxSettings>(
    `/api/workspaces/${organizationId}/report-inbox`,
  );
}

/** Ports the API accepts: 993, 143, 2525 only. The password is write-only —
 *  never returned, never stored client-side. */
export function setReportInbox(
  organizationId: string,
  body: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  },
): Promise<ReportInboxSettings> {
  return opsFetch<ReportInboxSettings>(
    `/api/workspaces/${organizationId}/report-inbox`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function deleteReportInbox(organizationId: string): Promise<void> {
  return opsFetch<void>(`/api/workspaces/${organizationId}/report-inbox`, {
    method: "DELETE",
  });
}

export function listSsoConnections(
  organizationId: string,
): Promise<{ connections: SsoConnectionRow[] }> {
  return opsFetch<{ connections: SsoConnectionRow[] }>(
    `/api/workspaces/${organizationId}/sso-connections`,
  );
}

/**
 * SSO connection creation, per the API's createSchema. allowedEmailDomains
 * cannot be empty when provisioning is JIT (API refuses) — the form shows the
 * constraint before save. defaultRole is analyst | viewer | admin only;
 * owner is never offered because the API never accepts it. The provider
 * secret is write-only; nothing here expects to read it back.
 */
export interface SsoConnectionCreate {
  label: string;
  protocol: "SAML" | "OIDC";
  issuer: string;
  entryPoint: string;
  clientId: string;
  clientSecret: string;
  idpCertificate?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  provisioning: "JIT" | "DISABLED";
  allowedEmailDomains: string[];
  defaultRole: "analyst" | "viewer" | "admin";
}

export function createSsoConnection(
  organizationId: string,
  body: SsoConnectionCreate,
): Promise<SsoConnectionRow> {
  return opsFetch<SsoConnectionRow>(
    `/api/workspaces/${organizationId}/sso-connections`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function deleteSsoConnection(
  organizationId: string,
  connectionId: string,
): Promise<void> {
  return opsFetch<void>(
    `/api/workspaces/${organizationId}/sso-connections/${connectionId}`,
    { method: "DELETE" },
  );
}

// ─── onboarding funnel (Phase 5) ─────────────────────────────────────────────

export function createClient(
  organizationId: string,
  body: { name: string; slug: string },
): Promise<{ id: string; name: string; slug: string }> {
  return opsFetch(`/api/workspaces/${organizationId}/clients`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function createDomain(
  organizationId: string,
  clientId: string,
  body: { name: string },
): Promise<DomainRow> {
  return opsFetch<DomainRow>(
    `/api/workspaces/${organizationId}/clients/${clientId}/domains`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Runs the live DNS ownership lookup and returns the TXT record to publish.
 *  A lookup that finds nothing answers PENDING — propagation time is a normal
 *  state, never an error. */
export function verifyDomain(
  organizationId: string,
  domainId: string,
): Promise<VerifyDomainResult> {
  return opsFetch<VerifyDomainResult>(
    `/api/workspaces/${organizationId}/domains/${domainId}/verify`,
    { method: "POST" },
  );
}

// ─── report shares (Phase 5) ─────────────────────────────────────────────────

export function listReportShares(
  organizationId: string,
  limit = 50,
): Promise<PageEnvelope<ReportShareRow>> {
  return opsFetch<PageEnvelope<ReportShareRow>>(
    `/api/workspaces/${organizationId}/report-shares?limit=${limit}`,
  );
}

export function createReportShare(
  organizationId: string,
  body: {
    domainId: string;
    includeForensics: boolean;
    includeSources: boolean;
    expiresInDays?: number;
  },
): Promise<CreatedShare> {
  return opsFetch<CreatedShare>(
    `/api/workspaces/${organizationId}/report-shares`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function revokeReportShare(
  organizationId: string,
  shareId: string,
): Promise<void> {
  return opsFetch<void>(
    `/api/workspaces/${organizationId}/report-shares/${shareId}`,
    { method: "DELETE" },
  );
}

// ─── portal access grants (agency side) ─────────────────────────────────────

// ─── trust center (agency side) ─────────────────────────────────────────────

/** GET /clients/:id/trust-center — the publish status for one client. */
export function trustCenterStatus(
  organizationId: string,
  clientId: string,
): Promise<TrustSlugStatus> {
  return opsFetch<TrustSlugStatus>(
    `/api/workspaces/${organizationId}/clients/${clientId}/trust-center`,
  );
}

/** GET /portal-access — every grant in the workspace, active and revoked. */
export function listPortalAccess(
  organizationId: string,
): Promise<{ grants: PortalGrant[] }> {
  return opsFetch<{ grants: PortalGrant[] }>(
    `/api/workspaces/${organizationId}/portal-access`,
  );
}
