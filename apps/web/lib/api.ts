/**
 * api.ts — server-side API access. Every call forwards the session cookie and
 * the base URL from env; nothing here is used from the browser.
 *
 * CONTRACT NOTE: GET /api/docs/openapi.json exposes only ApiError and Page
 * schemas, so request/response types are hand-mirrored from apps/api source in
 * lib/types.ts. Treat a typecheck failure here as a contract change to review,
 * not to cast away.
 *
 * BULK STATE: every domain's measurement comes from ONE call,
 * GET /api/workspaces/:id/domain-signals, through getAllDomainSignals. New
 * screens must not fan out per-domain calls for bulk state.
 */

import { cache } from "react";
import { redirect } from "next/navigation";
import { API_BASE, apiFetch as apiRequest } from "./api-fetch";
import { sessionCookieHeader } from "./session-cookie";
import { cookies } from "next/headers";
import type {
  ApiErrorBody,
  ClientRow,
  DomainInsights,
  DomainRow,
  DomainSignals,
  OnboardingState,
  PageEnvelope,
  ReportRow,
  WorkspaceSummary,
} from "./types";


/**
 * A response body as JSON, or null for an error body that is not JSON.
 *
 * A proxy in front of the API answers a 502 or a 504 with an HTML page.
 * Parsing that first threw a SyntaxError, which lost the status: a gateway
 * timeout read as a broken page instead of "the service did not answer". On
 * an error the status decides and an unreadable body is simply no body; a
 * success that is not JSON is still a fault and still throws.
 */
export function readBody<T>(text: string, ok: boolean): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    if (ok) throw cause;
    return null;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** Entitlement key on a 402 — the upgrade-prompt route, never guessed copy. */
  readonly feature: string | undefined;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error?.message ?? `API request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.error?.code;
    this.feature = body?.error?.feature;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const jar = await cookies();
  const header = new Headers(init?.headers);
  // Under either name: production's cookie carries the __Secure- prefix.
  const session = sessionCookieHeader(jar);
  if (session) header.set("cookie", session);

  /**
   * Through the shared requester, so every call from this module inherits its
   * deadline and its two distinct failure errors.
   *
   * The recursion here used to be a self-call: naming the wrapper and the transport
   * the same thing made the timeout impossible to add without first noticing that
   * `apiFetch` already meant something else here. Aliased at the import instead.
   */
  const res = await apiRequest(`${API_BASE}${path}`, {
    ...init,
    headers: header,
    cache: "no-store",
    credentials: "include",
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = readBody<T & ApiErrorBody>(text, res.ok);

  /**
   * A workspace requirement refuses the read, not the account. The account
   * security screen is the one place that can fix it, so every workspace call
   * lands there instead of showing a permission failure with no next step.
   */
  if (res.status === 403 && (body as ApiErrorBody | null)?.error?.code === "MFA_REQUIRED") {
    redirect("/account/security?required=1");
  }

  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? null);
  }
  return body as T;
}

// ─── workspaces ───────────────────────────────────────────────────────────────

export function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return apiFetch<WorkspaceSummary[]>("/api/workspaces");
}

/**
 * The signed-in user's own id, or null when there is no session.
 *
 * Needed for exactly one question so far: "is the person looking at this screen
 * the workspace owner", which decides whether the destructive control is shown
 * at all. Reading it from the server rather than inferring it from the member
 * list matters because an admin can see the roster including the owner's row -
 * and must not be handed the owner's power by a UI that guessed from proximity.
 *
 * Returns null rather than throwing on 401: a screen that only wants to hide a
 * button has no business redirecting the whole page over it.
 */
/**
 * The signed-in person, for the account menu: who the operator is signed in
 * as is a fact the shell must state, because an MSP shares machines and
 * browsers more than anyone admits. Null on any failure: a menu that cannot
 * name the user says "Signed in", it does not redirect.
 */
// Per-request memo (React cache): the shell, the settings context and a page
// all ask who is signed in, and three identical get-session calls per render
// were enough to trip the auth rate limit under load, which then read as "role
// unknown" on screen.
export const getSessionUser = cache(async (): Promise<{
  id: string;
  name: string | null;
  email: string;
  /** False for an account whose address is not confirmed yet; true only when Better Auth says so. */
  emailVerified: boolean;
} | null> => {
  try {
    const session = await apiFetch<{
      user?: { id?: string; name?: string | null; email?: string; emailVerified?: boolean };
    } | null>("/api/auth/get-session");
    const u = session?.user;
    return u?.id && u.email
      ? { id: u.id, name: u.name?.trim() || null, email: u.email, emailVerified: u.emailVerified === true }
      : null;
  } catch {
    return null;
  }
});

export const getSessionUserId = cache(async (): Promise<string | null> => (await getSessionUser())?.id ?? null);

/**
 * The workspace allowance: how many the account may hold and how many it holds.
 *
 * Read rather than probed. Attempting a creation to find out would spend an
 * allowance to answer a question about whether to spend one, and would leave a
 * junk workspace behind on the happy path. The numbers come from the same service
 * that enforces them, so what the page shows and what the API refuses cannot
 * drift apart.
 */
export interface WorkspaceAllowance {
  strongest: string;
  maxWorkspaces: number;
  used: number;
  remaining: number;
  allowed: boolean;
}

export async function readWorkspaceAllowance(): Promise<WorkspaceAllowance> {
  return apiFetch<WorkspaceAllowance>("/api/workspaces/allowance");
}

export function getEntitlements(organizationId: string): Promise<unknown> {
  return apiFetch(`/api/workspaces/${organizationId}/entitlements`);
}

// ─── clients & domains (the portfolio) ───────────────────────────────────────

export function listClients(organizationId: string): Promise<ClientRow[]> {
  return apiFetch<ClientRow[]>(`/api/workspaces/${organizationId}/clients`);
}

export function listClientDomains(
  organizationId: string,
  clientId: string,
): Promise<DomainRow[]> {
  return apiFetch<DomainRow[]>(
    `/api/workspaces/${organizationId}/clients/${clientId}/domains`,
  );
}

/** Pure mapping from an insights response to the portfolio's signal subset. */
export function deriveSignals(
  insights: DomainInsights,
  domainName: string,
  reportedPolicy: string | null,
): DomainSignals {
  // Attribution, measured: a sender that authenticates as some other domain is
  // seen traffic we cannot attribute to this domain. That is never a pass.
  const unattributedMessages = insights.senders
    .filter((s) => (s.senderDomain ?? "").toLowerCase() !== domainName.toLowerCase())
    .reduce((sum, s) => sum + s.totalMessages, 0);

  const a = insights.aggregate;
  return {
    reportCount: a.reportCount,
    messageCount: a.messageCount,
    failedMessages: a.failedMessages,
    unattributedMessages,
    spfPassRate: a.spfPassRate,
    dkimPassRate: a.dkimPassRate,
    lastReportAt: a.lastReportAt,
    reportedPolicy,
    // Already in the response; the portfolio draws it as each row's 30 days.
    trend: insights.trends.points,
    policyHistory: insights.policyHistory ?? [],
  };
}

/**
 * Signals for every domain in one request: GET /domain-signals counts them in
 * the database in a fixed number of queries, whatever the number of domains.
 * Nothing else should grow its own per-domain fan-out for portfolio state.
 *
 * A domain the response does not name (added between the two reads) stays
 * "signals unavailable": it is never resolved into a posture. Rule Zero. A
 * failed request throws, and the page says the portfolio could not be read.
 */
export async function getAllDomainSignals(
  organizationId: string,
  domains: Pick<DomainRow, "id" | "name">[],
): Promise<Map<string, DomainSignals | null>> {
  const out = new Map<string, DomainSignals | null>(domains.map((d) => [d.id, null]));
  if (domains.length === 0) return out;
  const body = await apiFetch<{ days: number; domains: Array<DomainSignals & { domainId: string }> }>(
    `/api/workspaces/${organizationId}/domain-signals`,
  );
  for (const { domainId, ...signals } of body.domains) {
    if (out.has(domainId)) out.set(domainId, signals);
  }
  return out;
}

// ─── domain evidence (Phase 2) ────────────────────────────────────────────────

export function getDomainInsights(
  organizationId: string,
  domainId: string,
): Promise<DomainInsights> {
  return apiFetch<DomainInsights>(
    `/api/workspaces/${organizationId}/domains/${domainId}/insights`,
  );
}

export function getOnboardingState(
  organizationId: string,
  domainId: string,
): Promise<OnboardingState> {
  return apiFetch<OnboardingState>(
    `/api/workspaces/${organizationId}/domains/${domainId}/onboarding`,
  );
}

export function listDomainReports(
  organizationId: string,
  domainId: string,
  limit = 25,
): Promise<PageEnvelope<ReportRow>> {
  return apiFetch<PageEnvelope<ReportRow>>(
    `/api/workspaces/${organizationId}/domains/${domainId}/reports?limit=${limit}`,
  );
}
