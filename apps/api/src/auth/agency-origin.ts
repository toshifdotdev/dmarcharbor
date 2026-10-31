import { env } from '../config/env.js';
import { findOrganizationByHost, resolveBranding } from '../services/branding.service.js';

/**
 * Which agency domains Better Auth may treat as trusted origins.
 *
 * An agency on Admiralty serves its clients on its own verified domain, for
 * example `reports.wistholm.example`. The web app serves that host and proxies
 * `/api/*` here, so a client signing in there sends `Origin:
 * https://reports.wistholm.example`. With a static `trustedOrigins` list Better
 * Auth refused that with 403 INVALID_ORIGIN, and refused a callbackURL on that
 * host, so a client could not sign in on the agency's domain at all.
 *
 * The rule, kept small so it can be tested on its own:
 *
 * - The candidate is the `Origin` header when there is one. Without one (the
 *   GET navigation an emailed verify or reset link makes) it is `https://`
 *   plus `x-forwarded-host`.
 * - With an `Origin`, `x-forwarded-host` must name the same hostname. The web
 *   app's proxy always sets it to the host the browser asked for. A page on
 *   another site calling this API directly cannot add that header without a
 *   CORS preflight, which our CORS answers without permission, so the pair is
 *   only seen on a request that really came through the agency's domain.
 * - The hostname must be a custom domain `resolveBranding` would present: the
 *   plan includes it and its ownership record is verified.
 * - https only, except http outside production, for the local verify harness
 *   (`http://brand-test.example:3200`). The port is kept.
 *
 * Answers are cached per hostname for a minute, found or not, so sign-in
 * traffic does not read the database on every request. Nothing here throws: a
 * lookup that fails adds no origin, and Better Auth then refuses the request
 * exactly as it did before this existed.
 */

export interface AgencyHost {
  organizationId: string;
  workspaceName: string;
}

const cacheLifetimeMs = 60_000;
const cacheLimit = 500;

const hostCache = new Map<string, { value: AgencyHost | null; expiresAt: number }>();

/** For tests, which change a workspace's domain between cases. */
export function resetAgencyHostCache(): void {
  hostCache.clear();
}

/**
 * Letters, digits, hyphens and dots only.
 *
 * Better Auth reads `*` and `?` in a trusted origin as wildcards, and the URL
 * parser lets both through in a hostname, so a stored custom domain such as
 * `*.example` would otherwise become a pattern that trusts every subdomain.
 */
const plainHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The origin to trust, if this value is an origin the rule allows at all.
 *
 * Returns the normalised origin (scheme, host and port) and its hostname, or
 * null. Says nothing yet about whether the host belongs to an agency.
 */
export function acceptableOrigin(value: string): { origin: string; hostname: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const secure = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && env.NODE_ENV !== 'production';
  if (!secure && !localHttp) {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (!plainHostname.test(hostname)) {
    return null;
  }

  return { origin: url.origin, hostname };
}

/** The first host in `x-forwarded-host`, which can be a list after several proxies. */
function forwardedHost(headers: Headers): string | null {
  const raw = headers.get('x-forwarded-host');
  const first = raw?.split(',')[0]?.trim().toLowerCase();
  return first ? first : null;
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The origins this request could be trusted for, before any lookup.
 *
 * Usually one. With no `Origin` header the scheme is not known, so outside
 * production the http form is offered as well as https; in production only
 * https is.
 */
export function candidateOrigins(headers: Headers): string[] {
  const forwarded = forwardedHost(headers);
  if (!forwarded) {
    return [];
  }

  // Any Origin header counts as present, including the opaque "null", which
  // parses as no URL and so offers nothing.
  const origin = headers.get('origin');
  if (origin !== null) {
    let originHostname: string;
    try {
      originHostname = new URL(origin).hostname.toLowerCase();
    } catch {
      return [];
    }
    // The proxy's header must agree with the browser's, or the pair did not
    // come through our web app on that host.
    return hostnameOf(forwarded) === originHostname ? [origin] : [];
  }

  return env.NODE_ENV === 'production' ? [`https://${forwarded}`] : [`https://${forwarded}`, `http://${forwarded}`];
}

async function lookUp(hostname: string): Promise<AgencyHost | null> {
  const found = await findOrganizationByHost(hostname);
  if (!found?.verified) {
    return null;
  }
  // The same gate the portal uses to present the domain: licensed for the
  // custom domain and verified. A domain kept after a downgrade stops here.
  const branding = await resolveBranding(found.organizationId);
  if (branding.customDomain !== hostname) {
    return null;
  }
  return { organizationId: found.organizationId, workspaceName: branding.workspaceName };
}

/**
 * The agency a hostname is served for, or null. Cached; never throws.
 *
 * A failed lookup is not cached, so a database blip costs one refused request
 * rather than a minute of refused sign-ins.
 */
export async function lookupAgencyHost(hostname: string, now: number = Date.now()): Promise<AgencyHost | null> {
  const key = hostname.toLowerCase();
  const cached = hostCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached) {
    hostCache.delete(key);
  }

  let value: AgencyHost | null;
  try {
    value = await lookUp(key);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown lookup error.';
    console.error(`[auth] agency host lookup failed for ${key}: ${detail}`);
    return null;
  }

  // Bounded. The oldest entry goes first, which Map's insertion order gives
  // for free, so a flood of made-up hostnames cannot grow this without limit.
  while (hostCache.size >= cacheLimit) {
    const oldest = hostCache.keys().next().value;
    if (oldest === undefined) break;
    hostCache.delete(oldest);
  }
  hostCache.set(key, { value, expiresAt: now + cacheLifetimeMs });
  return value;
}

/** The agency behind an absolute URL's origin, if the rule allows that origin. */
export async function agencyForOrigin(value: string): Promise<{ origin: string; agency: AgencyHost } | null> {
  const accepted = acceptableOrigin(value);
  if (!accepted) {
    return null;
  }
  const agency = await lookupAgencyHost(accepted.hostname);
  return agency ? { origin: accepted.origin, agency } : null;
}

/** The agency origin this request came through, if any. Never throws. */
export async function agencyOriginsForRequest(request?: Request | null): Promise<string[]> {
  try {
    const headers = request?.headers;
    if (!headers || typeof headers.get !== 'function') {
      return [];
    }

    const trusted: string[] = [];
    for (const candidate of candidateOrigins(headers)) {
      const accepted = acceptableOrigin(candidate);
      // Our own web origin arrives here too, on every request through the
      // proxy. It is trusted already and is not an agency, so no lookup.
      if (!accepted || env.CORS_ORIGINS.includes(accepted.origin)) {
        continue;
      }
      if (await lookupAgencyHost(accepted.hostname)) {
        trusted.push(accepted.origin);
      }
    }
    return trusted;
  } catch {
    return [];
  }
}

/**
 * Better Auth's `trustedOrigins`.
 *
 * Called once at start-up with no request, which gets the static list, and
 * then for each request, which gets the static list plus that request's agency
 * origin when it has one.
 */
export async function trustedOriginsFor(request?: Request): Promise<string[]> {
  return [...env.CORS_ORIGINS, ...(await agencyOriginsForRequest(request))];
}
