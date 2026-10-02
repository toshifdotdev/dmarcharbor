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

import { cookies } from "next/headers";
import type {
  AlertEventRow,
  AlertRuleRow,
  ApiErrorBody,
  BillingStatus,
  BrandingSettings,
  CheckoutRequest,
  CheckoutSummary,
  CreatedShare,
  DomainRow,
  PlanDefinition,
  ReportDigestRow,
  ReportInboxSettings,
  ReportShareRow,
  ResolvedEntitlements,
  SsoConnectionRow,
  VerifyDomainResult,
  WorkspaceMemberRow,
  PageEnvelope,
} from "./types";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

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

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: header,
    cache: "no-store",
    credentials: "include",
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T & ApiErrorBody) : null;
  if (!res.ok) throw new OpsError(res.status, (body as ApiErrorBody) ?? null);
  return body as T;
}

// ─── billing & entitlements ──────────────────────────────────────────────────

export function getWorkspaceEntitlements(
  organizationId: string,
): Promise<ResolvedEntitlements> {
  return opsFetch<ResolvedEntitlements>(
    `/api/workspaces/${organizationId}/entitlements`,
  );
}

export function getBillingStatus(organizationId: string): Promise<BillingStatus> {
  return opsFetch<BillingStatus>(`/api/workspaces/${organizationId}/billing`);
}

/** The full plan catalog with prices as integer minor units. The only source
 *  of plan names and prices — never hardcoded in a component. */
export function getPlanCatalog(): Promise<{ plans: PlanDefinition[]; order: string[] }> {
  return opsFetch<{ plans: PlanDefinition[]; order: string[] }>("/api/plans");
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
): Promise<unknown> {
  return opsFetch(`/api/workspaces/${organizationId}/billing/plan`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function cancelSubscription(organizationId: string): Promise<unknown> {
  return opsFetch(`/api/workspaces/${organizationId}/billing/cancel`, {
    method: "POST",
  });
}

export function resumeSubscription(organizationId: string): Promise<unknown> {
  return opsFetch(`/api/workspaces/${organizationId}/billing/resume`, {
    method: "POST",
  });
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
): Promise<unknown> {
  return opsFetch(
    `/api/workspaces/${organizationId}/alerts/${eventId}/acknowledge`,
    { method: "POST" },
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

export function listWorkspaceMembers(
  organizationId: string,
): Promise<{ members: WorkspaceMemberRow[] }> {
  return opsFetch<{ members: WorkspaceMemberRow[] }>(
    `/api/workspaces/${organizationId}/members`,
  );
}

export function getBranding(
  organizationId: string,
): Promise<BrandingSettings> {
  return opsFetch<BrandingSettings>(`/api/workspaces/${organizationId}/branding`);
}

/** Colours only. The logo is the three-step upload flow below — a typed
 *  logo URL is NEVER rendered (security rule: they are filtered out of
 *  client-facing responses server-side). */
export function updateBranding(
  organizationId: string,
  body: { brandPrimaryColor?: string | null; brandAccentColor?: string | null },
): Promise<BrandingSettings> {
  return opsFetch<BrandingSettings>(
    `/api/workspaces/${organizationId}/branding`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export function setCustomDomain(
  organizationId: string,
  customDomain: string | null,
): Promise<unknown> {
  return opsFetch(`/api/workspaces/${organizationId}/branding/custom-domain`, {
    method: "PUT",
    body: JSON.stringify({ customDomain }),
  });
}

export function verifyCustomDomain(organizationId: string): Promise<unknown> {
  return opsFetch(
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
