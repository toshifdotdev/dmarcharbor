/**
 * white-label.ts — what an agency's verified custom domain serves, and the
 * client-facing addresses the API hands back.
 *
 * On an agency's verified domain the reader is the agency's client. Our
 * marketing, documentation and legal pages describe us and sell to MSPs, so
 * under the agency's name they would be wrong twice over: proxy.ts sends them
 * to the portal instead. Everything a client is ever sent to keeps working
 * there: the portal, sign-in and sign-up, shared reports, Trust Centers,
 * prospect reports, the verifier, the downloads, the /api rewrite and the
 * icons. The signed-in staff screens are left alone: staff work on our domain
 * and nothing on the agency's links to them.
 *
 * Pure functions with no Next imports, so the policy is unit-tested
 * (tests/white-label.test.ts) and the browser bundle can use the URL helpers.
 */

/**
 * Routes about us, never about the agency. Each matches itself and anything
 * under it, so /docs covers /docs/api and every document below it.
 */
export const VENDOR_ROUTES = [
  "/pricing",
  // The free tools sell our product to MSPs; an agency's client has no use for them.
  "/tools",
  "/glossary",
  "/guides",
  "/guide",
  "/faq",
  "/docs",
  "/support",
  "/privacy",
  "/terms",
  "/dpa",
  "/refunds",
  "/acceptable-use",
  "/security",
  "/sub-processors",
  "/complaints",
  "/cookies",
  // Creating a workspace: an agency's client never does that on its domain.
  "/welcome",
] as const;

function normalise(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * True when a GET for this path on an agency's verified domain goes to the
 * portal instead: the home page (our landing) and every route about us.
 */
export function isVendorRoute(pathname: string): boolean {
  const path = normalise(pathname);
  if (path === "/" || path === "") return true;
  return VENDOR_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

/**
 * The portal without a session, on an agency's verified domain: the `next`
 * value for /sign-in, or null to let the page decide.
 *
 * The portal page already sends a signed-out reader to sign-in, but from
 * inside a streamed render (the route has a loading state), which Next can
 * only do with a one-second meta refresh after the loading mark has shown.
 * With no session cookie at all the answer is known before rendering, so the
 * proxy says it as a plain redirect. A cookie that is present but expired
 * still reaches the page, which redirects as before. A failed verification
 * link (?error=…) also reaches the page, because the page turns its code into
 * the sentence the sign-in form shows.
 */
export function signedOutPortalNext(pathname: string, params: URLSearchParams, hasSession: boolean): string | null {
  if (hasSession || normalise(pathname) !== "/portal" || params.has("error")) return null;
  const org = params.get("org");
  return org ? `/portal?org=${encodeURIComponent(org)}` : "/portal";
}

/**
 * An absolute http(s) URL from the API, or null. A link the API built for a
 * client (a share page on the agency's domain) is shown and copied as it is,
 * but never anything that is not a web address, so a bad value can never
 * become a javascript: href.
 */
export function absoluteHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The scheme and host of an absolute http(s) URL from the API, or null. */
export function httpOrigin(raw: unknown): string | null {
  const url = absoluteHttpUrl(raw);
  return url ? new URL(url).origin : null;
}
