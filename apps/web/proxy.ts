import { NextResponse, type NextRequest } from "next/server";
import http from "node:http";
import { supportEmailOrNull, supportUrlOrNull } from "./lib/agency-contact";
import { hasSessionCookie } from "./lib/session-cookie";
import { wwwTwinRedirect } from "./lib/site-config";
import {
  HOST_KIND_HEADER,
  docsIndexRedirect,
  hostKind,
  hostnameOf,
  robotsHeaderFor,
  siteOriginFrom,
  type HostState,
} from "./lib/site-host";
import { isVendorRoute, signedOutPortalNext } from "./lib/white-label";

/**
 * Custom-domain resolution (Phase 8 — the Admiralty feature that did not work
 * end to end): when an agency points their own domain at us, GET
 * /api/branding/host answers which workspace owns that Host header. Nothing
 * was calling it, so every agency domain served default branding — a paid
 * feature that looked broken. This proxy is that call.
 *
 * CONVENTION: Next 16.3 renamed the middleware file to `proxy`, and the
 * export must be named `proxy` (or default). It runs on the Node runtime —
 * which is load-bearing here, not incidental: the API resolves branding by the
 * request's Host header, and Node's fetch() refuses to send an explicit Host
 * (it recomputes it from the URL), so the lookup goes through node:http,
 * which sends it. Verified: node:http with `host:` gets the branding; fetch
 * with the same header gets a 404 because the header never left the client.
 *
 * CACHING (a lookup per request would make every custom domain slower than
 * the product behind it):
 * - Verified, branded hosts cache 10 minutes. Branding changes are rare and a
 *   stale colour beats a slow first paint.
 * - Unverified / unmatched hosts cache 2 minutes, so a domain that is mid-setup
 *   heals quickly once its record verifies.
 * - A lookup that errors or times out caches a MISS for 30 seconds. A miss is
 *   cheap by design and never breaks the default site: the request continues
 *   unbranded rather than failing.
 *
 * A domain that is pointed here but whose record is NOT verified is flagged
 * `unverified` — the shell says so plainly rather than serving half-branded,
 * because half a brand looks like a bug in ours.
 *
 * A VERIFIED agency domain is the client's address, not ours: our landing,
 * pricing, guides and legal pages redirect to the portal there (see
 * agencyHostTarget below and lib/white-label.ts).
 *
 * Two workspaces can never claim the same host: customDomain is a unique
 * column server-side, so the lookup cannot be spoofed into stealing one.
 *
 * App-local hostnames (localhost, the deployment host) never pay the lookup:
 * they short-circuit before any network call.
 */

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const DEFAULT_HOSTS = new Set(
  [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "[::1]",
    process.env.NEXT_PUBLIC_APP_HOST ?? "",
  ].filter(Boolean),
);

type CacheEntry = {
  state: "verified" | "unverified" | "miss";
  brand: {
    workspaceName: string;
    logoUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    /** The agency's client contact, for the portal foot and the sign-in page. */
    supportEmail: string | null;
    supportUrl: string | null;
  } | null;
  expires: number;
  /** The lookup failed (timeout, API down): nothing is known about the host. */
  failed?: boolean;
};

const TTL_VERIFIED_MS = 10 * 60 * 1000;
const TTL_UNVERIFIED_MS = 2 * 60 * 1000;
/**
 * A failed lookup is remembered for 5 seconds, not 30. It says nothing about
 * the host, so the next request should ask again soon (session 18: a slow
 * first lookup served our /tools page on an agency's domain).
 */
const TTL_FAILED_MS = 5 * 1000;
// In development the cache is kept short on purpose: a custom-domain fixture
// flips verified → unverified mid-test, and a 2-minute TTL would serve the old
// state while the test reads it. Production keeps the real durations above.
// HOST_BRAND_CACHE_FACTOR scales them for a production build run under the
// clickthrough harness (0 = no cache). Server-side only and set by whoever
// starts the process; anything unparseable falls back to the default.
const cacheFactorOverride = Number.parseFloat(process.env.HOST_BRAND_CACHE_FACTOR ?? "");
const DEV_CACHE_FACTOR =
  Number.isFinite(cacheFactorOverride) && cacheFactorOverride >= 0
    ? cacheFactorOverride
    : process.env.NODE_ENV === "production"
      ? 1
      : 0;

// Per-isolate cache. The right consistency level for colours and a logo;
// correctness of WHO owns a host is enforced server-side (unique column).
const cache = new Map<string, CacheEntry>();

/** node:http, not fetch: only it will send the Host header the API reads. */
function lookupBranding(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: new URL(API_BASE).hostname,
        port: Number(new URL(API_BASE).port || 80),
        path: "/api/branding/host",
        method: "GET",
        headers: { host },
        timeout: 1500,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("branding lookup timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * JSON with every character outside printable ASCII written as a \u escape,
 * which JSON.parse reads back as the same text.
 *
 * A header value must be a byte string: Headers.set throws on a character
 * above U+00FF, so an agency named "Łódź IT", or a support address with such
 * a character before the @, would have failed every request on its domain.
 */
function headerSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function resolveHost(host: string): Promise<CacheEntry> {
  const hit = cache.get(host);
  if (hit && hit.expires > Date.now()) return hit;
  if (hit) cache.delete(host);

  // A lookup that failed: cached briefly, and the request proceeds unbranded,
  // except that pages about us are not served on it (see the proxy below).
  const miss: CacheEntry = { state: "miss", brand: null, failed: true, expires: Date.now() + TTL_FAILED_MS * DEV_CACHE_FACTOR };
  try {
    const body = await lookupBranding(host);
    const parsed = JSON.parse(body) as {
      branded?: boolean;
      customDomainVerified?: boolean;
      workspaceName?: string;
      logoUrl?: string | null;
      primaryColor?: string | null;
      accentColor?: string | null;
      supportEmail?: unknown;
      supportUrl?: unknown;
    };
    const verified = parsed.branded === true && parsed.customDomainVerified === true;
    const entry: CacheEntry = {
      state: verified ? "verified" : parsed.customDomainVerified === false ? "unverified" : "miss",
      brand: verified
        ? {
            workspaceName: parsed.workspaceName ?? "",
            // Only a platform-served uploaded object ever reaches an <img>: a
            // typed logo URL is filtered out server-side, and rendering one
            // would be a security bug.
            logoUrl: parsed.logoUrl ?? null,
            primaryColor: parsed.primaryColor ?? null,
            accentColor: parsed.accentColor ?? null,
            // Checked here and again where they are read (lib/host-brand.ts):
            // only one plain address and a full https page are carried.
            supportEmail: supportEmailOrNull(parsed.supportEmail),
            supportUrl: supportUrlOrNull(parsed.supportUrl),
          }
        : null,
      expires: Date.now() + (verified ? TTL_VERIFIED_MS : TTL_UNVERIFIED_MS) * DEV_CACHE_FACTOR,
    };
    cache.set(host, entry);
    return entry;
  } catch {
    cache.set(host, miss);
    return miss;
  }
}

/**
 * The Content-Security-Policy, with a per-request nonce.
 *
 * This lives here rather than in next.config.ts because the policy names a value
 * that only exists once a request arrives. Next.js ships its React bootstrap and
 * the RSC flight data as inline scripts, so `script-src 'self'` with no nonce
 * blocks all ten of them and the page never hydrates: every route sat on its
 * loading.tsx fallback forever while every server-side check still passed. Next
 * applies the nonce it finds in the request's CSP to its own tags automatically,
 * so the policy can stay strict without breaking the framework.
 *
 * `strict-dynamic` lets the one nonced bootstrap load the rest of the chunks it
 * needs, which is why the script-src list stays short instead of enumerating
 * every bundle.
 *
 * `style-src` keeps 'unsafe-inline' and must: this codebase styles with React
 * `style` props pervasively, which the browser sees as inline style attributes.
 *
 * Development adds 'unsafe-eval' because React uses eval to rebuild server error
 * stacks in the browser. Neither React nor Next use eval in production.
 */
function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";
  /**
   * Hosted BIMI logos are served from their own origin, so `img-src` has to
   * name it or the panel's `<img>` is blocked. Only `img-src`, and only when
   * the deployment sets it: the bytes are images, and nothing else on the page
   * should be able to load from that host. Parsed as a URL so a malformed
   * value cannot inject a directive into the header.
   */
  const bimiOrigin = (() => {
    const raw = process.env.HOSTED_BIMI_ORIGIN?.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
    } catch {
      return null;
    }
  })();
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // This build serves its own domain and every agency's custom domain from the
    // same output, so connect-src cannot be pinned to one origin.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${bimiOrigin ? ` ${bimiOrigin}` : ""}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // An auditor may open a compliance verifier link; nothing else may frame us.
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  // Generated before the host branch so the app-local case (localhost, the
  // deployment host) still gets a nonce and a policy: those are the requests
  // that most need hydrating, and they used to be the ones that got none.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  // The route being served, for the metadata layer: a layout's
  // generateMetadata() renders for every route under it and cannot otherwise
  // tell which one it is, and the root layout needs that to keep forty-odd
  // protected screens out of a search index while leaving the public set in.
  // See lib/seo.ts.
  requestHeaders.set("x-harbor-path", request.nextUrl.pathname);

  // The brand headers are this proxy's to set, never the client's: a request
  // that arrived carrying them on our own host would otherwise render any
  // agency name it liked, error pages included (lib/host-brand.ts trusts them).
  requestHeaders.delete("x-harbor-host-state");
  requestHeaders.delete("x-harbor-brand");
  requestHeaders.delete(HOST_KIND_HEADER);

  const rawHost = request.headers.get("host") ?? "";
  const host = rawHost.split(":")[0];

  // www.dmarcharbor.com (or the bare host, when SITE_URL is the www. one) is
  // the same site under a second address: send it to the one address,
  // permanently, before any lookup. Only GET and HEAD, so a form post is never
  // turned into a lost request. Nothing happens while SITE_URL is unset.
  const siteOrigin = siteOriginFrom(process.env.SITE_URL);
  const wwwTarget =
    request.method === "GET" || request.method === "HEAD"
      ? wwwTwinRedirect({ hostname: hostnameOf(request.headers.get("x-forwarded-host") ?? rawHost), siteOrigin })
      : null;
  if (wwwTarget) {
    // The path is set on the URL rather than resolved against it, so a path
    // such as //other.example can never become a redirect to another site.
    const target = new URL(wwwTarget);
    target.pathname = request.nextUrl.pathname;
    target.search = request.nextUrl.search;
    return NextResponse.redirect(target, 308);
  }

  let hostState: HostState = "default";
  let lookupFailed = false;
  if (host && !DEFAULT_HOSTS.has(host)) {
    const entry = await resolveHost(host);
    lookupFailed = entry.failed === true;
    hostState = entry.state;
    requestHeaders.set("x-harbor-host-state", entry.state);
    if (entry.brand) {
      requestHeaders.set("x-harbor-brand", headerSafeJson(entry.brand));
    }
  }

  // Our public host, an agency's verified domain, or another host serving our
  // pages (lib/site-host.ts). Decided once here and stamped, so the robots meta
  // the layout renders (lib/site-origin.ts reads the stamp) and the
  // X-Robots-Tag header below always agree. The hostname is the one the
  // canonical origin is built from (X-Forwarded-Host first, as in
  // lib/metadata-origin.ts), so a reverse proxy that rewrites Host does not
  // turn our own host into a duplicate.
  const kind = hostKind({
    state: hostState,
    hostname: hostnameOf(request.headers.get("x-forwarded-host") ?? rawHost),
    siteOrigin,
  });
  requestHeaders.set(HOST_KIND_HEADER, kind);
  const robotsHeader = robotsHeaderFor({ kind, pathname: request.nextUrl.pathname });

  // On an agency's verified domain the tab and app icons are the agency's,
  // never our Pier (app/brand-icon/[spec]/route.tsx).
  const agencyIcon = requestHeaders.get("x-harbor-host-state") === "verified" ? agencyIconTarget(request) : null;
  if (agencyIcon) {
    const iconResponse = NextResponse.rewrite(agencyIcon, { request: { headers: requestHeaders } });
    iconResponse.headers.set("Content-Security-Policy", csp);
    return iconResponse;
  }

  // On an agency's verified domain the reader is the agency's client, so the
  // pages about us (our landing, pricing, guides, legal pages, creating a
  // workspace) are not served there: they go to the portal, the client's own
  // landing. Unverified, unmatched and our own hosts never reach this.
  const agencyTarget = requestHeaders.get("x-harbor-host-state") === "verified" ? agencyHostTarget(request) : null;
  if (agencyTarget) return NextResponse.redirect(agencyTarget, 307);

  /**
   * Fail closed. When the lookup for a host that is not ours failed, it may
   * be an agency's domain, and our pricing or tools page there would show our
   * name to the agency's client. The pages about us go to /portal instead,
   * temporarily (307), exactly as on a verified agency domain; everything a
   * client is sent to is served as usual.
   */
  if (lookupFailed && (request.method === "GET" || request.method === "HEAD") && isVendorRoute(request.nextUrl.pathname)) {
    const target = request.nextUrl.clone();
    target.search = "";
    target.pathname = "/portal";
    return NextResponse.redirect(target, 307);
  }

  // /docs has no page of its own while there is one developer document. Here,
  // after the agency check, rather than in next.config.ts: config redirects
  // run before the proxy, so an agency's /docs would first hop permanently to
  // /docs/api and only then to /portal (lib/site-host.ts docsIndexRedirect).
  const docsTarget =
    request.method === "GET" || request.method === "HEAD" ? docsIndexRedirect(request.nextUrl.pathname) : null;
  if (docsTarget) {
    const target = request.nextUrl.clone();
    target.pathname = docsTarget;
    return NextResponse.redirect(target, 308);
  }

  const exportPage = exportDownloadPage(request);
  // The address the person opened, for the export page to read. A rewritten
  // route handler does not reliably see the rewrite's own query string, so the
  // original path and its token travel in a header this proxy alone sets.
  requestHeaders.delete("x-harbor-export-path");
  if (exportPage) requestHeaders.set("x-harbor-export-path", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = exportPage
    ? NextResponse.rewrite(exportPage, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set("Content-Security-Policy", csp);
  // noindex before any HTML: the tenant artefacts on every host, every page
  // on a host that is neither ours nor a verified agency's, and the verifier
  // on an agency's domain (lib/site-host.ts robotsHeaderFor).
  if (robotsHeader) response.headers.set("X-Robots-Tag", robotsHeader);
  return response;
}

/**
 * A data export's emailed link, opened in a browser, goes to the page that
 * can say "expired" in words (app/exports/download/route.ts) instead of the
 * /api rewrite, which would show the API's JSON. Only a GET whose Accept asks
 * for HTML, which is what a click on a link sends: an API client asking for
 * the file as JSON or CSV still reaches the API directly. The ids are checked
 * here and again in the route.
 */
const EXPORT_DOWNLOAD = /^\/api\/workspaces\/([A-Za-z0-9_-]{1,64})\/exports\/([A-Za-z0-9_-]{1,64})\/download$/;

function exportDownloadPage(request: NextRequest): URL | null {
  if (request.method !== "GET") return null;
  const match = EXPORT_DOWNLOAD.exec(request.nextUrl.pathname);
  if (!match) return null;
  if (!(request.headers.get("accept") ?? "").includes("text/html")) return null;
  const target = request.nextUrl.clone();
  target.pathname = "/exports/download";
  target.search = "";
  target.searchParams.set("org", match[1]);
  target.searchParams.set("id", match[2]);
  const token = request.nextUrl.searchParams.get("token");
  if (token) target.searchParams.set("token", token);
  return target;
}

/**
 * Where a request on an agency's verified domain goes instead, or null to
 * serve it (lib/white-label.ts holds the policy and its tests).
 *
 * - Our home page and the routes about us go to /portal. Temporary (307), so
 *   nothing caches it: the same path is our page again if the domain stops
 *   being verified. No query travels except the portal's own `org`.
 * - /portal with no session cookie goes straight to sign-in, which the page
 *   would otherwise do from inside a streamed render: a loading mark and a
 *   one-second meta refresh before the form.
 *
 * Only GET and HEAD: a form post or a server action is never redirected. The
 * target keeps the request's own host, so Next sends it as a relative
 * Location and the browser stays on the agency's domain.
 */
function agencyHostTarget(request: NextRequest): URL | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = request.nextUrl.pathname;
  const org = request.nextUrl.searchParams.get("org");
  const target = request.nextUrl.clone();
  target.search = "";
  if (isVendorRoute(path)) {
    target.pathname = "/portal";
    if (org) target.searchParams.set("org", org);
    return target;
  }
  // Either name: production's cookie carries the __Secure- prefix (lib/session-cookie.ts).
  const next = signedOutPortalNext(path, request.nextUrl.searchParams, hasSessionCookie(request.cookies));
  if (next) {
    target.pathname = "/sign-in";
    target.searchParams.set("next", next);
    return target;
  }
  return null;
}

/**
 * The static icon addresses, and the agency icon each one becomes on a
 * verified agency host. The browser asks for /favicon.ico on its own, the
 * page links /icon.svg and /apple-icon.png (with a cache-busting query), and
 * the manifest names /icons/*.
 */
const ICON_SIZE = /^\/icons\/icon-(16|32|48|180|192|512)\.png$/;

function agencyIconTarget(request: NextRequest): URL | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = request.nextUrl.pathname;
  // The shape is in the path: a rewritten route does not see the query string.
  let spec: string | null = null;
  if (path === "/favicon.ico") spec = "48-tab-png";
  else if (path === "/icon.svg") spec = "128-tab-svg";
  else if (path === "/apple-icon.png") spec = "180-bleed-png";
  else if (path === "/icons/maskable-512.png") spec = "512-mask-png";
  else {
    const match = ICON_SIZE.exec(path);
    if (match) spec = `${match[1]}-bleed-png`;
  }
  if (!spec) return null;
  const target = request.nextUrl.clone();
  target.pathname = `/brand-icon/${spec}`;
  target.search = "";
  return target;
}

// Everything except Next's own build assets is a candidate for branded chrome,
// the favicon included (an agency host serves its own). The lookup is cached,
// and app-local hosts short-circuit above.
export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
