import { redirect } from "next/navigation";
import { API_BASE, apiFetch, SLOW_API_TIMEOUT_MS } from "@/lib/api-fetch";
import { linkErrorPage } from "@/lib/link-error-page";
import { retryAfterFrom, retryAfterText } from "@/lib/retry-after";

export const dynamic = "force-dynamic";

/**
 * A data export's download link, opened in a browser.
 *
 * The API mints the link as /api/workspaces/{org}/exports/{id}/download?token=…
 * on this origin (the email and the settings screen both use it), and the
 * /api rewrite used to hand the browser the API's answer as is: raw JSON for
 * an expired or revoked link. proxy.ts now sends a browser navigation to that
 * address here instead (an API client asking for JSON still goes straight
 * through). On success the file streams through unchanged; every refusal is a
 * page that says what happened and what to do.
 *
 * The API answers one 404 for an invalid, expired or revoked link, by design,
 * so the page does not guess which.
 */
const KIND = "Data export";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_NEW = { href: "/settings/export", label: "Request a new export" };

/** The API's own address for the download, as proxy.ts matched it. */
const EXPORT_PATH = /^\/api\/workspaces\/([A-Za-z0-9_-]{1,64})\/exports\/([A-Za-z0-9_-]{1,64})\/download$/;

/**
 * Which export, and its token. proxy.ts puts the address the person opened in
 * x-harbor-export-path (it deletes any copy a client sent), because a rewritten
 * route handler did not see the rewrite's query string: every link, live ones
 * included, read as incomplete. The query is still read first, for a direct
 * visit to /exports/download?org=…&id=…&token=….
 */
function target(request: Request): { org: string; id: string; token: string } {
  const url = new URL(request.url);
  const fromQuery = {
    org: url.searchParams.get("org") ?? "",
    id: url.searchParams.get("id") ?? "",
    token: url.searchParams.get("token") ?? "",
  };
  if (fromQuery.org && fromQuery.id) return fromQuery;
  const opened = request.headers.get("x-harbor-export-path");
  if (!opened) return fromQuery;
  const original = new URL(opened, url.origin);
  const match = EXPORT_PATH.exec(original.pathname);
  return match
    ? { org: match[1]!, id: match[2]!, token: original.searchParams.get("token") ?? "" }
    : fromQuery;
}

export async function GET(request: Request): Promise<Response> {
  const { org, id, token } = target(request);
  if (!ID.test(org) || !ID.test(id)) {
    return linkErrorPage({
      status: 404,
      kind: KIND,
      closed: true,
      heading: "This export link is not valid",
      detail: "The address is not a complete export link. Open it again from the email, or request a new export.",
      actions: [REQUEST_NEW],
    });
  }
  // The address the person opened, for signing in and coming back to it.
  const original = `/api/workspaces/${org}/exports/${id}/download${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const again = { href: original, label: "Try the link again" };

  const headers: Record<string, string> = { accept: "application/json, text/csv, */*" };
  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;

  let upstream: Response;
  try {
    upstream = await apiFetch(`${API_BASE}${original}`, {
      cache: "no-store",
      timeoutMs: SLOW_API_TIMEOUT_MS,
      headers,
    });
  } catch {
    return linkErrorPage({
      status: 502,
      kind: KIND,
      heading: "This export cannot be downloaded just now",
      detail: "Nothing is wrong with the link: the service did not answer. It keeps working until it expires, so try again in a few minutes.",
      actions: [again],
    });
  }

  if (upstream.ok && upstream.body) {
    const out = new Headers();
    for (const name of ["content-type", "content-length", "content-disposition"]) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    out.set("cache-control", "no-store");
    out.set("referrer-policy", "no-referrer");
    out.set("x-content-type-options", "nosniff");
    return new Response(upstream.body, { status: 200, headers: out });
  }

  const code = await upstream
    .json()
    .then((body: { error?: { code?: unknown } }) => (typeof body?.error?.code === "string" ? body.error.code : null))
    .catch(() => null);

  // The session ended (or was never there): sign in, then land back on the
  // same link, which then downloads. safeNext accepts this same-site path.
  if (upstream.status === 401) redirect(`/sign-in?next=${encodeURIComponent(original)}`);
  if (upstream.status === 403 && code === "MFA_REQUIRED") redirect("/account/security?required=1");

  if (upstream.status === 400) {
    return linkErrorPage({
      status: 400,
      kind: KIND,
      closed: true,
      heading: "This export link is incomplete",
      detail: "Part of the link is missing. Open it again from the email, or request a new export.",
      actions: [REQUEST_NEW],
    });
  }
  if (upstream.status === 404 || upstream.status === 410) {
    return linkErrorPage({
      status: 404,
      kind: KIND,
      closed: true,
      heading: "This export link has expired or was revoked",
      detail:
        "An export link works for a limited time and stops at once when someone revokes it. Request a new export from the workspace's settings.",
      actions: [REQUEST_NEW],
    });
  }
  if (upstream.status === 403) {
    return linkErrorPage({
      status: 403,
      kind: KIND,
      heading: "Your role cannot download this export",
      detail:
        "You are signed in, but your role in this workspace does not include downloading exports. An owner or admin can download it for you, or change your role.",
      actions: [{ href: "/", label: "Back to the portfolio" }],
    });
  }
  if (upstream.status === 402) {
    return linkErrorPage({
      status: 402,
      kind: KIND,
      heading: "Data export is not on this workspace's plan",
      detail: "Nothing was deleted: the plan no longer carries downloads of exports. An owner can see the options in Billing.",
      actions: [{ href: "/billing", label: "See plan options" }],
    });
  }
  if (upstream.status === 429) {
    const wait = retryAfterFrom(upstream.headers);
    return linkErrorPage({
      status: 429,
      kind: KIND,
      heading: "Too many download attempts",
      detail: `Nothing is wrong with the link. ${retryAfterText(wait, "try the link again")}`,
      actions: [again],
      headers: wait ? { "retry-after": String(wait) } : undefined,
    });
  }
  return linkErrorPage({
    status: 502,
    kind: KIND,
    heading: "This export cannot be downloaded just now",
    detail:
      "Nothing is wrong with the link: the service answered with an error. It keeps working until it expires, so try again in a few minutes.",
    actions: [again],
  });
}
