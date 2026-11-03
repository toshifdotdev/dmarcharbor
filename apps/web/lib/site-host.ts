/**
 * site-host.ts — which kind of host a request arrived on, and what that means
 * for a crawler before any HTML is rendered.
 *
 * One build answers on three kinds of host:
 *
 *   own     our public host: SITE_URL's hostname, or (SITE_URL unset, as in
 *           development and the verify harness) a host the proxy treats as
 *           ours (state "default"). The only host whose pages may be indexed.
 *   agency  an agency's verified custom domain. Its own origin is canonical
 *           for the pages served there, and our per-route rules apply.
 *   other   anything else pointed at us: an unverified or unknown hostname,
 *           and www./app./raw-IP duplicates of our own pages once SITE_URL is
 *           set. Every page there is noindex.
 *
 * Pure, with no imports, so proxy.ts, lib/site-origin.ts and the tests share
 * one decision (tests/site-host.test.ts).
 */

export type HostState = "verified" | "unverified" | "miss" | "default";
export type HostKind = "own" | "agency" | "other";

/**
 * The request header the proxy stamps with the host kind, so the metadata
 * layer and the X-Robots-Tag header can never disagree. Stripped from the
 * client's request first, like the brand headers.
 */
export const HOST_KIND_HEADER = "x-harbor-host-kind";

/** SITE_URL's origin, or null when it is unset or is not an http(s) URL. */
export function siteOriginFrom(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The hostname of a Host or X-Forwarded-Host value: the first entry of a
 * comma list, lower case, without its port. Null when there is none.
 */
export function hostnameOf(raw: string | null | undefined): string | null {
  const first = raw?.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  // An IPv6 literal keeps its brackets; only a trailing :port is removed.
  if (first.startsWith("[")) {
    const end = first.indexOf("]");
    return end > 0 ? first.slice(0, end + 1) : first;
  }
  return first.replace(/:\d+$/, "") || null;
}

export interface HostKindInput {
  /** The proxy's brand state for the host ("default" for app-local hosts). */
  state: HostState;
  /** The request's hostname (hostnameOf), or null when none arrived. */
  hostname: string | null;
  /** siteOriginFrom(process.env.SITE_URL). */
  siteOrigin: string | null;
}

/** Which kind of host this request is on. See the table at the top. */
export function hostKind({ state, hostname, siteOrigin }: HostKindInput): HostKind {
  if (state === "verified") return "agency";
  if (!siteOrigin) return state === "default" ? "own" : "other";
  if (!hostname) return "other";
  return hostname === new URL(siteOrigin).hostname ? "own" : "other";
}

/** A stamped host kind read back, or null when absent or not one of ours. */
export function parseHostKind(raw: string | null | undefined): HostKind | null {
  return raw === "own" || raw === "agency" || raw === "other" ? raw : null;
}

/**
 * The origin canonical URLs, the sitemap and structured data are built on: an
 * agency's own origin on its verified domain (so its pages never point at
 * ours), SITE_URL everywhere else, and the request's own origin when SITE_URL
 * is unset.
 */
export function canonicalOriginFor(input: { kind: HostKind; requestOrigin: string; siteOrigin: string | null }): string {
  if (input.kind === "agency") return input.requestOrigin;
  return input.siteOrigin ?? input.requestOrigin;
}

/**
 * Tenant artefacts: reachable without a session from links an agency sends,
 * and the same document as on the agency's own domain. robots.txt leaves them
 * crawlable on purpose, so a crawler that finds a link can read the noindex
 * (a disallowed URL can be indexed from a link without its noindex ever being
 * fetched).
 */
export const ARTEFACT_PREFIXES = ["/portal", "/share", "/trust", "/prospect"] as const;

/** True when the path is one of the prefixes or anything under one. */
export function underPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The X-Robots-Tag value for a response, or null to send none.
 *
 * The header holds the rule before any HTML is parsed, and for responses that
 * have no <meta> at all. The page metadata says the same (lib/crawl-policy.ts
 * robotsForRequest), so the two never disagree.
 */
export function robotsHeaderFor(input: { kind: HostKind; pathname: string }): string | null {
  if (underPrefix(input.pathname, ARTEFACT_PREFIXES)) return "noindex, nofollow";
  if (input.kind === "other") return "noindex";
  // The verifier is served on an agency's domain because the agency's
  // compliance packs link there; it is the agency's page, not one to index.
  if (input.kind === "agency" && input.pathname === "/verify") return "noindex, nofollow";
  return null;
}

/**
 * /docs has no index page while there is one developer document, so the
 * address goes to it (permanent). Checked in tests against DEVELOPER_DOCS: a
 * second document means /docs needs a page of its own and this goes.
 *
 * Done in proxy.ts rather than next.config.ts redirects on purpose: config
 * redirects run BEFORE the proxy (node_modules/next/dist/docs/01-app/
 * 03-api-reference/03-file-conventions/proxy.md, "Execution order"), so an
 * agency host would take a permanent hop to /docs/api before the proxy sent it
 * on to /portal. In the proxy the agency check comes first.
 */
export const DOCS_INDEX_TARGET = "/docs/api";

export function docsIndexRedirect(pathname: string): string | null {
  return pathname === "/docs" || pathname === "/docs/" ? DOCS_INDEX_TARGET : null;
}
