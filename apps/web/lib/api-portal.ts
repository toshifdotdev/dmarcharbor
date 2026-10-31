import { API_BASE, apiFetch } from "./api-fetch";
import { sessionCookieHeader } from "./session-cookie";
import { cookies, headers } from "next/headers";
import type {
  PortalBranding,
  PortalOverview,
  PortalDomainDetail,
  PortalMonthlyReports,
  PortalPolicyProposal,
} from "./types";

/**
 * api-portal.ts — the client contact's reads. A contact sees their own
 * clients' verified domains and measurement only. FORENSIC DATA NEVER PASSES
 * THROUGH THIS FILE: portal contacts are outside that boundary by contract
 * (brief rule 5), so there is no call here that could fetch it — not even
 * speculatively behind a guard.
 *
 * A contact invited by more than one provider names which one with `org`;
 * without it the API answers CHOOSE_WORKSPACE with the choices.
 */

export interface PortalWorkspaceChoice {
  organizationId: string;
  name: string;
  clients: string[];
}

export class PortalError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly workspaces: PortalWorkspaceChoice[];
  /** Sent with PORTAL_PAUSED: the provider whose plan no longer includes the portal. */
  readonly workspaceName: string | null;
  /**
   * The API's own sentence, or null when it sent none. On an agency's domain a
   * refusal names that agency and no other ("This account has not been given
   * access to a client report from Wistholm IT."), so the page can show it as
   * it is.
   */
  readonly apiMessage: string | null;

  constructor(
    status: number,
    code: string | undefined,
    message: string | undefined,
    workspaces: PortalWorkspaceChoice[] = [],
    workspaceName: string | null = null,
  ) {
    super(message ?? `Portal request failed (${status})`);
    this.name = "PortalError";
    this.status = status;
    this.code = code;
    this.workspaces = workspaces;
    this.workspaceName = workspaceName;
    this.apiMessage = typeof message === "string" && message.trim() ? message.trim() : null;
  }
}

/**
 * The Host this page was requested on, or null.
 *
 * Null during a static prerender, where no request exists and headers()
 * throws: then there is no agency host to name.
 */
async function requestHost(): Promise<string | null> {
  try {
    return (await headers()).get("host")?.trim() || null;
  } catch {
    return null;
  }
}

function withOrg(path: string, org?: string | null): string {
  if (!org) return path;
  return `${path}${path.includes("?") ? "&" : "?"}organizationId=${encodeURIComponent(org)}`;
}

async function portalFetch<T>(path: string): Promise<T> {
  const jar = await cookies();
  const header = new Headers();
  // Under either name: production's cookie carries the __Secure- prefix.
  const session = sessionCookieHeader(jar);
  if (session) header.set("cookie", session);

  // The host the contact opened the portal on. On an agency's verified domain
  // the API scopes every portal read to that agency (requirePortalScope): no
  // provider choice is offered there, and a refusal names only that agency.
  // This server-side call reaches the API directly rather than through the
  // /api rewrite, so no x-forwarded-host says where the reader is; this
  // header does. It can only narrow what a contact sees, never widen it: the
  // grants are still the contact's own, and a host that is not an agency's
  // changes nothing.
  const host = await requestHost();
  if (host) header.set("x-harbor-portal-host", host);

  const res = await apiFetch(`${API_BASE}${path}`, {
    headers: header,
    cache: "no-store",
    credentials: "include",
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = body as {
      error?: { code?: string; message?: string; workspaces?: PortalWorkspaceChoice[]; workspaceName?: string | null };
    } | null;
    throw new PortalError(
      res.status,
      err?.error?.code,
      err?.error?.message,
      Array.isArray(err?.error?.workspaces) ? err.error.workspaces : [],
      typeof err?.error?.workspaceName === "string" ? err.error.workspaceName : null,
    );
  }
  return body as T;
}

/**
 * The contact's identity gate: /portal 403s when the signed-in account has no
 * client grant, and the middleware decides that — this app never invents its
 * own permission logic. A 401 or 403 sends the reader to a plain explanation.
 */
export async function getPortalOverview(org?: string | null): Promise<PortalOverview> {
  return portalFetch<PortalOverview>(withOrg("/api/portal", org));
}

export function getPortalDomain(domainId: string, org?: string | null): Promise<PortalDomainDetail> {
  return portalFetch<PortalDomainDetail>(withOrg(`/api/portal/domains/${domainId}`, org));
}

/** Open requests to approve a stricter policy, across the contact's clients. */
export function getPortalProposals(org?: string | null): Promise<{ proposals: PortalPolicyProposal[] }> {
  return portalFetch<{ proposals: PortalPolicyProposal[] }>(withOrg("/api/portal/policy-proposals", org));
}

/** The open request and the last few answered ones for one domain. */
export function getPortalDomainProposals(
  domainId: string,
  org?: string | null,
): Promise<{ proposals: PortalPolicyProposal[] }> {
  return portalFetch<{ proposals: PortalPolicyProposal[] }>(
    withOrg(`/api/portal/domains/${domainId}/policy-proposals`, org),
  );
}

export function getPortalBranding(org?: string | null): Promise<PortalBranding> {
  return portalFetch<PortalBranding>(withOrg("/api/portal/branding", org));
}

/** The non-superseded monthly reports for one client the contact can reach. */
export function getPortalMonthlyReports(
  clientId: string,
  org?: string | null,
): Promise<PortalMonthlyReports> {
  return portalFetch<PortalMonthlyReports>(
    withOrg(`/api/portal/clients/${clientId}/monthly-reports`, org),
  );
}
