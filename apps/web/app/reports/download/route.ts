import { API_BASE, apiFetch, SLOW_API_TIMEOUT_MS } from "@/lib/api-fetch";
import { linkErrorPage } from "@/lib/link-error-page";
import { retryAfterFrom, retryAfterText } from "@/lib/retry-after";

export const dynamic = "force-dynamic";

/**
 * The client-facing download link from the monthly report email.
 *
 * It streams the API's public download through the web origin so the recipient
 * never sees raw JSON. A bad or expired link is a plain page with one sentence,
 * not an API error body: the person clicking is an agency client, not an
 * integration developer (lib/link-error-page.ts draws it, with the host's name).
 *
 * The API answers one 404 for an unknown, expired or malformed token, by
 * design, so this page does not guess which; it says what to do in every case.
 * A failure to reach the service and a rate limit are temporary and say so,
 * with a way to try the same link again.
 */
const KIND = "Monthly report";

function gone(): Promise<Response> {
  return linkErrorPage({
    status: 404,
    kind: KIND,
    closed: true,
    heading: "This report link is not available",
    detail: "It may have expired, or it may not have been copied completely. Ask the sender for a new link.",
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) return gone();
  // The same address again: the token is already in it.
  const again = { href: `${url.pathname}${url.search}`, label: "Try the link again" };

  let upstream: Response;
  try {
    upstream = await apiFetch(
      `${API_BASE}/api/monthly-reports/download?token=${encodeURIComponent(token)}`,
      {
        cache: "no-store",
        credentials: "omit",
        timeoutMs: SLOW_API_TIMEOUT_MS,
        headers: { accept: "application/pdf" },
      },
    );
  } catch {
    return linkErrorPage({
      status: 502,
      kind: KIND,
      heading: "This report cannot be downloaded just now",
      detail: "Nothing is wrong with the link: the service did not answer. Try again in a few minutes.",
      actions: [again],
    });
  }

  if (upstream.status === 404 || upstream.status === 410) return gone();
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
  if (!upstream.ok || !upstream.body) {
    return linkErrorPage({
      status: 502,
      kind: KIND,
      heading: "This report cannot be downloaded just now",
      detail:
        "Nothing is wrong with the link: the service answered with an error. Try again in a few minutes, or ask the sender for a new link if it keeps happening.",
      actions: [again],
    });
  }

  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-disposition",
    "x-dmarc-pack-sha256",
    "x-dmarc-pack-reference",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");

  return new Response(upstream.body, { status: 200, headers });
}
