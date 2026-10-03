/**
 * api.ts — server-side API access. Every call forwards the session cookie and
 * the base URL from env; nothing here is used from the browser.
 *
 * CONTRACT NOTE: GET /api/docs/openapi.json exposes only ApiError and Page
 * schemas, so request/response types are hand-mirrored from apps/api source in
 * lib/types.ts. Treat a typecheck failure here as a contract change to review,
 * not to cast away.
 *
 * N+1 NOTE (known API gap, bulk endpoint coming): GET
 * /api/workspaces/:id/domains?include=signals will return domains with their
 * measurement state in ONE call. Until it lands, per-domain signals come from
 * getDomainSignals below with bounded concurrency. New screens must not fan
 * out per-domain calls for bulk state — mark the site and use
 * getAllDomainSignals as the single place to collapse when the endpoint lands.
 */

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

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

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

  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? null);
  }
  return body as T;
}

// ─── workspaces ───────────────────────────────────────────────────────────────

export function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return apiFetch<WorkspaceSummary[]>("/api/workspaces");
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
  };
}

/**
 * Measurement signals for one domain.
 *
 * N+1 NOTE: the reports fetch here is the same collapse site as the insights
 * fetch — both fold into the single GET
 * /api/workspaces/:id/domains?include=signals when it lands. The reports call
 * exists because the domain row's dmarcPolicy is written ONLY by a DNS scan
 * (domain-scan.service.ts), so an unscanned domain would otherwise assert
 * "no record" while its reports carry the policy their reporters actually
 * observed (policy_published → policyP).
 */
export async function getDomainSignals(
  organizationId: string,
  domainId: string,
  domainName: string,
): Promise<DomainSignals> {
  const [insights, reports] = await Promise.all([
    getDomainInsights(organizationId, domainId),
    listDomainReports(organizationId, domainId, 3),
  ]);
  return deriveSignals(insights, domainName, reports.items[0]?.policyP ?? null);
}

/**
 * Signals for every domain, fetched with bounded concurrency.
 *
 * N+1 NOTE: this is the site to collapse when GET
 * /api/workspaces/:id/domains?include=signals lands. Nothing else should
 * grow its own per-domain fan-out for portfolio state.
 */
export async function getAllDomainSignals(
  organizationId: string,
  domains: Pick<DomainRow, "id" | "name">[],
  concurrency = 6,
): Promise<Map<string, DomainSignals | null>> {
  const out = new Map<string, DomainSignals | null>();
  const queue = [...domains];

  async function worker(): Promise<void> {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        out.set(job.id, await getDomainSignals(organizationId, job.id, job.name));
      } catch {
        // A row whose signals cannot load stays "signals unavailable": it is
        // never resolved into a posture. Rule Zero.
        out.set(job.id, null);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
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
