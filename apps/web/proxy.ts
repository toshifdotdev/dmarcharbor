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
const DEV_CACHE_FACTOR = process.env.NODE_ENV === "production" ? 1 : 0;

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

export async function proxy(request: NextRequest) {
  const rawHost = request.headers.get("host") ?? "";
  const host = rawHost.split(":")[0];
  if (!host || DEFAULT_HOSTS.has(host)) {
    return NextResponse.next();
  }

  const entry = await resolveHost(host);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-harbor-host-state", entry.state);
  if (entry.brand) {
    requestHeaders.set("x-harbor-brand", JSON.stringify(entry.brand));
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

// Everything except static assets is a candidate for branded chrome — the
// lookup is cached, and app-local hosts short-circuit above.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
