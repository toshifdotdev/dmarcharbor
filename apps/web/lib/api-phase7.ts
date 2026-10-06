import { API_BASE, apiFetch } from "./api-fetch";
import { cookies } from "next/headers";
import type {
  ApiErrorBody,
  CompliancePackRow,
  PublicShareReport,
  SessionRow,
} from "./types";

/**
 * api-phase7.ts — server-side reads and writes for Phase 7: account sessions,
 * compliance packs, and the public share report.
 *
 * The share report is fetched WITHOUT credentials (public disclosure surface);
 * the session and pack calls forward the session cookie like lib/api-ops.
 */


export class OpsError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error?.message ?? `API request failed (${status})`);
    this.name = "OpsError";
    this.status = status;
    this.code = body?.error?.code;
  }
}

async function authedFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
  if (!res.ok) throw new OpsError(res.status, (body as ApiErrorBody) ?? null);
  return body as T;
}

// ─── account (account level) ─────────────────────────────────────────────────

/** GET /api/me — the signed-in account. better-auth's session payload carries
 *  { session, user }; the checkout contact form is filled from it rather than
 *  asking for details the platform already holds. */
export function getMe(): Promise<{
  user?: { name?: string; email?: string };
  session?: unknown;
}> {
  return authedFetch("/api/me");
}

// ─── sessions (account level) ────────────────────────────────────────────────

/** GET /api/me/sessions — device, IP (approximate location), created, expires.
 *  The API does not expose a last-seen timestamp; the UI renders what exists
 *  and never invents one. */
export function listSessions(): Promise<{ sessions: SessionRow[] }> {
  return authedFetch<{ sessions: SessionRow[] }>("/api/me/sessions");
}

export function revokeSession(sessionId: string): Promise<void> {
  return authedFetch<void>(`/api/me/sessions/${sessionId}`, { method: "DELETE" });
}

/** The lost-laptop action: signs out every other session, spares this one. */
export function revokeOtherSessions(): Promise<{ remaining: SessionRow[] } | void> {
  return authedFetch("/api/me/sessions/revoke-others", { method: "POST" });
}

/** The deliberate nuke — INCLUDING this device, so the caller is signed out
 *  too. That is the correct semantic for its name; a compromised account must
 *  be able to sign itself out. The UI confirms before calling it. */
export function revokeAllSessions(): Promise<void> {
  return authedFetch<void>("/api/me/sessions/revoke-all", { method: "POST" });
}

// ─── compliance packs ────────────────────────────────────────────────────────

export function listCompliancePacks(
  organizationId: string,
  clientId: string,
): Promise<{ packs: CompliancePackRow[] }> {
  return authedFetch<{ packs: CompliancePackRow[] }>(
    `/api/workspaces/${organizationId}/clients/${clientId}/compliance-packs`,
  );
}

/**
 * Issues a pack: the response IS the PDF, and the fingerprint travels in its
 * headers (X-DMARC-Pack-Sha256 / X-DMARC-Pack-Reference). Returns the bytes
 * plus the two header values so the caller can present the fingerprint as the
 * primary artefact and hand the PDF to the browser.
 */
export async function issueCompliancePack(
  organizationId: string,
  clientId: string,
): Promise<{ bytes: Blob; reference: string; sha256: string; filename: string }> {
  const jar = await cookies();
  const header = new Headers();
  const session = jar.get("better-auth.session_token");
  if (session) header.set("cookie", `better-auth.session_token=${session.value}`);

  const res = await apiFetch(
    `${API_BASE}/api/workspaces/${organizationId}/clients/${clientId}/compliance-packs`,
    { method: "POST", headers: header, cache: "no-store", credentials: "include" },
  );
  if (!res.ok) {
    const text = await res.text();
    let body: ApiErrorBody | null;
    try {
      body = text ? (JSON.parse(text) as ApiErrorBody) : null;
    } catch {
      body = null;
    }
    throw new OpsError(res.status, body);
  }

  const disposition = res.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename="([^"]+)"/);
  return {
    bytes: await res.blob(),
    reference: res.headers.get("x-dmarc-pack-reference") ?? "",
    sha256: res.headers.get("x-dmarc-pack-sha256") ?? "",
    filename: filenameMatch?.[1] ?? `dmarc-compliance-${Date.now()}.pdf`,
  };
}

// ─── public share report (no credentials) ────────────────────────────────────

/** GET /api/reports/share/:token — public by design. No session cookie is
 *  attached on purpose: this is a disclosure surface a client opens cold. A
 *  revoked or expired token answers 404; the page says so plainly and is
 *  rendered uncached, never a stale copy of a share that no longer exists. */
export async function getPublicShareReport(
  token: string,
): Promise<PublicShareReport | null> {
  const res = await apiFetch(
    `${API_BASE}/api/reports/share/${encodeURIComponent(token)}`,
    { cache: "no-store", credentials: "omit", headers: { accept: "application/json" } },
  );
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) {
    let body: ApiErrorBody | null;
    try {
      body = text ? (JSON.parse(text) as ApiErrorBody) : null;
    } catch {
      body = null;
    }
    throw new OpsError(res.status, body);
  }
  return (text ? JSON.parse(text) : null) as PublicShareReport | null;
}
