import { API_BASE, apiFetch } from "./api-fetch";
import { cookies } from "next/headers";
import type { PortalBranding, PortalOverview, PortalDomainDetail, PortalMonthlyReports } from "./types";

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
  }
}

function withOrg(path: string, org?: string | null): string {
  if (!org) return path;
  return `${path}${path.includes("?") ? "&" : "?"}organizationId=${encodeURIComponent(org)}`;
}

async function portalFetch<T>(path: string): Promise<T> {
  const jar = await cookies();
  const header = new Headers();
  const session = jar.get("better-auth.session_token");
  if (session) header.set("cookie", `better-auth.session_token=${session.value}`);

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
