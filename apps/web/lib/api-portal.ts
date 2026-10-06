import { API_BASE, apiFetch } from "./api-fetch";
import { cookies } from "next/headers";
import type { PortalBranding, PortalOverview, PortalDomainDetail } from "./types";

/**
 * api-portal.ts — the client contact's reads. A contact sees their own
 * clients' verified domains and measurement only. FORENSIC DATA NEVER PASSES
 * THROUGH THIS FILE: portal contacts are outside that boundary by contract
 * (brief rule 5), so there is no call here that could fetch it — not even
 * speculatively behind a guard.
 */


export class PortalError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string | undefined) {
    super(message ?? `Portal request failed (${status})`);
    this.name = "PortalError";
    this.status = status;
    this.code = code;
  }
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
    const err = body as { error?: { code?: string; message?: string } } | null;
    throw new PortalError(res.status, err?.error?.code, err?.error?.message);
  }
  return body as T;
}

/**
 * The contact's identity gate: /portal 403s when the signed-in account has no
 * client grant, and the middleware decides that — this app never invents its
 * own permission logic. A 401 or 403 sends the reader to a plain explanation.
 */
export async function getPortalOverview(): Promise<PortalOverview> {
  return portalFetch<PortalOverview>("/api/portal");
}

export function getPortalDomain(domainId: string): Promise<PortalDomainDetail> {
  return portalFetch<PortalDomainDetail>(`/api/portal/domains/${domainId}`);
}

export function getPortalBranding(): Promise<PortalBranding> {
  return portalFetch<PortalBranding>("/api/portal/branding");
}
