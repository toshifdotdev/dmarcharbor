import { NextResponse, type NextRequest } from "next/server";
import http from "node:http";

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
  } | null;
  expires: number;
};

const TTL_VERIFIED_MS = 10 * 60 * 1000;
const TTL_UNVERIFIED_MS = 2 * 60 * 1000;
const TTL_MISS_MS = 30 * 1000;
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

async function resolveHost(host: string): Promise<CacheEntry> {
  const hit = cache.get(host);
  if (hit && hit.expires > Date.now()) return hit;
  if (hit) cache.delete(host);

  // The cheap miss: cached briefly, and the request proceeds unbranded.
  const miss: CacheEntry = { state: "miss", brand: null, expires: Date.now() + TTL_MISS_MS * DEV_CACHE_FACTOR };
  try {
    const body = await lookupBranding(host);
    const parsed = JSON.parse(body) as {
      branded?: boolean;
      customDomainVerified?: boolean;
      workspaceName?: string;
      logoUrl?: string | null;
      primaryColor?: string | null;
      accentColor?: string | null;
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

  const rawHost = request.headers.get("host") ?? "";
  const host = rawHost.split(":")[0];

  let response: NextResponse;
  if (!host || DEFAULT_HOSTS.has(host)) {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else {
    const entry = await resolveHost(host);
    requestHeaders.set("x-harbor-host-state", entry.state);
    if (entry.brand) {
      requestHeaders.set("x-harbor-brand", JSON.stringify(entry.brand));
    }
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

// Everything except static assets is a candidate for branded chrome — the
// lookup is cached, and app-local hosts short-circuit above.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
