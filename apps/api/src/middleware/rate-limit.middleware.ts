import { createHash } from 'node:crypto';
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import { env } from '../config/env.js';
import { rateLimitStoreFor } from './postgres-rate-limit-store.js';

/**
 * What every limiter in this file shares.
 *
 * `passOnStoreError` is the load-bearing one, and it is why this constant
 * exists rather than nine copies of the same two options.
 *
 * The counters live in a Postgres table, so the store is on the request path.
 * The store used to fail open by returning an empty window
 * (`{ totalHits: 0 }`), and express-rate-limit has validated that value since
 * 7.x: `ERR_ERL_INVALID_HITS`. The hand-rolled fallback therefore took the
 * route down instead of opening it — a counting-table blip became a 500 on
 * every limited endpoint, which is the exact outcome the fallback was written
 * to prevent. The library's own mechanism does the same job correctly: the
 * error is logged and the request continues unrate-limited.
 *
 * The header options are policy too. `draft-7` is the IETF draft every other
 * limiter speaks, and the legacy `X-RateLimit-*` spellings are off rather than
 * emitted alongside, because four headers saying three things reads as a bug.
 */
const SHARED_LIMITER_OPTIONS: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  passOnStoreError: true,
};


/**
 * Counter stores, shared across replicas.
 *
 * These were the library's default in-process `Map`, and behind a load balancer that
 * means every replica enforces its own complete budget. A limit written as 600 per
 * minute was 1800 across three replicas and 1800 across six, with nothing in the
 * configuration to indicate it. The same Map reset on every deploy, which quietly made
 * a rolling restart a way to exceed a budget repeatedly.
 *
 * The store is now a Postgres table. The service already depends on it, it is already
 * required for any request to succeed, and there is no Redis here to introduce. The
 * cost is a round trip per limited request, which is why these limiters are mounted
 * only where they do work rather than on every route.
 *
 * One store instance per limiter, each carrying its own name, because the library does
 * not tell a store which limiter is calling it. Sharing a single instance would have put
 * every limiter's buckets in the same rows, so a client who exhausted their sign-in
 * budget would silently exhaust their API budget as well.
 *
 * The prerequisite the old comment warned about is in place: `trust proxy` is set from
 * `TRUST_PROXY_HOPS`, so every replica agrees on the client address and therefore on
 * the bucket. Without it a shared store would have been worse than a per-process one,
 * collapsing every client in the service into a single key.
 */

/**
 * A stable bucket for one client address.
 *
 * IPv6 is collapsed to its /64 before hashing. A single residential IPv6
 * customer is routinely handed a whole /64, and keying on the full address lets
 * one person exhaust an entire budget by rotating through it, or lets an
 * attacker evade the limit the same way. The prefix keeps IPv4 behaviour
 * unchanged.
 *
 * The `v4:`/`v6:` prefixes matter: express-rate-limit inspects generated keys
 * and warns when one looks like a bare IPv6 address, because that is almost
 * always an un-normalised key.
 */
export function clientKey(request: { ip?: string; socket?: { remoteAddress?: string } }): string {
  const address = (request.ip ?? request.socket?.remoteAddress ?? 'unknown').split('%')[0]!.toLowerCase();

  if (!address.includes(':')) {
    return `v4:${address}`;
  }

  // IPv4-mapped IPv6, which is what a dual-stack listener reports for a v4 peer.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) {
    return `v4:${mapped[1]}`;
  }

  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];

  return `v6:${groups.slice(0, 4).map((group) => group.padStart(4, '0')).join(':')}::/64`;
}

export function createScanRateLimiter(
  limit = env.SCAN_RATE_LIMIT_PER_MINUTE,
): RateLimitRequestHandler {
  return rateLimit({
    ...SHARED_LIMITER_OPTIONS,
    windowMs: 60_000,
    limit,
    store: rateLimitStoreFor('scan'),
    keyGenerator: clientKey,
  });
}

export function createReportIngestRateLimiter(
  limit = env.REPORT_INGEST_RATE_LIMIT_PER_MINUTE,
): RateLimitRequestHandler {
  return rateLimit({
    ...SHARED_LIMITER_OPTIONS,
    windowMs: 60_000,
    limit,
    store: rateLimitStoreFor('report-ingest'),
    keyGenerator: clientKey,
  });
}

export function createSecureSessionRouterRateLimiter(
  limit = env.SESSION_ROUTER_RATE_LIMIT_PER_MINUTE,
): RateLimitRequestHandler {
  return rateLimit({
    ...SHARED_LIMITER_OPTIONS,
    windowMs: 60_000,
    limit,
    store: rateLimitStoreFor('session-router'),
    keyGenerator: clientKey,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many security requests. Wait a minute and try again.',
      },
    },
  });
}


/**
 * Better Auth paths that only read the caller's own session state: who is
 * signed in, their sessions, their organizations and invitations. GET only,
 * matched against the path relative to the `/api/auth` mount.
 *
 * These used to share the sign-in budget (20 a minute per address), and the
 * web app asks `get-session` on every server render. A person clicking through
 * a dozen pages, or an office of staff behind one address, spent the budget on
 * page views, and their next real sign-in was refused with a 429. They guess
 * nothing, so they need a brake, not the credential-stuffing limit.
 *
 * `verify-email` is deliberately absent: it is a GET, but it takes a token, so
 * it is a guess and stays under the strict limit.
 */
const SESSION_READ_PATH =
  /^\/(get-session|list-sessions|organization\/(list|list-members|list-invitations|list-user-invitations|get-full-organization|get-active-member))$/;

export function isSessionRead(request: { method: string; path: string }): boolean {
  return request.method === 'GET' && SESSION_READ_PATH.test(request.path);
}

/**
 * The brake for session reads, at the same per-address budget as the
 * authenticated workspace routes. Applies to nothing else.
 */
export function createSessionReadRateLimiter(limit = env.WORKSPACE_RATE_LIMIT_PER_MINUTE): RateLimitRequestHandler {
  return rateLimit({
    ...SHARED_LIMITER_OPTIONS,
    windowMs: 60_000,
    limit,
    store: rateLimitStoreFor('auth-session-read'),
    keyGenerator: clientKey,
    skip: (request) => !isSessionRead(request),
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests from this network. Wait a minute and try again.',
      },
    },
  });
}

/**
 * Sign-in, sign-up, password reset and email verification.
 *
 * Better Auth ships its own limiter but it is per-instance in-memory and resets
 * on deploy, so behind a load balancer the effective limit is multiplied by the
 * replica count and reset to full on every release. This is the primary brake
 * on credential stuffing and password spraying; the two-factor endpoints live
 * under the same auth prefix and share this budget, with the plugin's own
 * five-attempt and account-lockout limits on top.
 *
 * Mounted ahead of the Better Auth handler, so it applies to every auth path
 * including the social sign-in start.
 */
export function createAuthRateLimiter(limit = env.AUTH_RATE_LIMIT_PER_MINUTE): RateLimitRequestHandler {
  return rateLimit({
    ...SHARED_LIMITER_OPTIONS,
    windowMs: 60_000,
    limit,
    store: rateLimitStoreFor('auth'),
    keyGenerator: clientKey,
    // Session reads have their own budget (createSessionReadRateLimiter).
    skip: isSessionRead,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many sign-in attempts. Wait a minute and try again.',
      },
    },
  });
}


/**
 * Brake on the authenticated routes, which had no limit at all.
 *
 * The gap was real: `apiRateLimiter` guards the machine-to-machine surface, the auth
 * limiter guards sign-in, and everything a signed-in user can reach had neither. That
 * included the routes that build a PDF, generate an export or run a scan, which are
 * the expensive ones, so one runaway loop or one abusive script could saturate the
 * process for every tenant.
 *
 * Keyed on the address, which is a compromise worth naming. Keying on the workspace
 * would be better, because an agency whose staff share one office address would
 * otherwise share a budget. It cannot be done from a router level `use`, because the
 * workspace only reaches `response.locals` once `requireSession` has run on the route,
 * and a limiter mounted before that sees nothing to key on. Doing it properly means
 * either moving the limiter inside each route definition or resolving the session
 * twice, so this takes the address and the limit is set high enough not to catch an
 * office.
 *
 * A brake, not a quota. An agency legitimately importing several hundred domains in one
 * action must not be stopped by it.
 */
export function createWorkspaceRateLimiter(
  limit = env.WORKSPACE_RATE_LIMIT_PER_MINUTE,
): RateLimitRequestHandler {
  return rateLimit({
    ...SHARED_LIMITER_OPTIONS,
    windowMs: 60_000,
    limit,
    store: rateLimitStoreFor('workspace'),
    keyGenerator: clientKey,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests from this network. Wait a minute and try again.',
      },
    },
  });
}


/**
 * Unauthenticated flood guard for the machine-to-machine API.
 *
 * Keyed on the client address because at this point in the middleware chain no
 * credential has been verified. It is not the tenant's budget; that is
 * `apiKeyRateLimiter`. It exists so an unauthenticated caller cannot drive an
 * unbounded number of key lookups.
 *
 * This previously keyed on the last 24 characters of the Authorization header,
 * which is attacker controlled: a caller with no valid key at all could send a
 * different header value per request and receive a fresh bucket every time,
 * making the limit decorative.
 */
export const apiRateLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,
  windowMs: 60_000,
  limit: 300,
  store: rateLimitStoreFor('api'),
  keyGenerator: clientKey,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many API requests. Wait a minute and try again.',
    },
  },
});


/**
 * The authenticated tenant budget for the machine-to-machine API.
 *
 * Runs after `requireApiKey` and keys on the resolved key id, so one workspace
 * exhausting its budget cannot spend anyone else's, and revoking a key resets
 * its bucket because the id disappears.
 */
export function createApiKeyRateLimiter(limit = env.API_RATE_LIMIT_PER_MINUTE): RateLimitRequestHandler {
  return rateLimit({
    ...SHARED_LIMITER_OPTIONS,
    windowMs: 60_000,
    limit,
    store: rateLimitStoreFor('api-key'),
    keyGenerator: (request, response) => {
      const keyId = (response?.locals as { apiKeyId?: string } | undefined)?.apiKeyId;
      return keyId ? `key:${keyId}` : `ip:${clientKey(request)}`;
    },
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many API requests for this key. Wait a minute and try again.',
      },
    },
  });
}


/**
 * The public compliance pack verifier.
 *
 * Unauthenticated by design: the person holding a pack is an auditor, not a
 * customer, and they have no way to authenticate. That makes it a free oracle, so
 * it needs a budget.
 *
 * Deliberately tighter than the share-link limiter. A share link is a 256 bit
 * token handed to one recipient; guessing is hopeless, so the limit there only
 * exists to stop enumeration of the token space by accident. A pack reference
 * carries a client name and an issue date in clear, so the only unknown is the
 * suffix, and the endpoint distinguishes a hit from a miss with a 200 and a 404.
 * Without a limit that is an offline-search problem dressed up as an endpoint.
 *
 * The suffix is now 96 bits, which is the real fix. This is what stops a single
 * determined caller rather than a crowd.
 */
export const compliancePackVerifyRateLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,
  windowMs: 60_000,
  limit: 10,
  store: rateLimitStoreFor('compliance-verify'),
  keyGenerator: clientKey,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many verification attempts. Wait a minute and try again.',
    },
  },
});


/**
 * A brake on the public Trust Centre, which had none at all.
 *
 * The slug is unguessable, but an unguessable slug is not a rate limit: the page
 * carries a client name, a domain and a compliance posture in clear, and there is
 * no second factor on reading it. Without a limit one caller can walk the public
 * surface, or simply hammer it, and nothing notices. The compliance verifier next
 * door has had one since it was built.
 */
/**
 * Issuing a monthly report is a twenty-a-hour workspace operation.
 *
 * The limiter is keyed on the workspace, not the caller's address: an agency
 * with several staff shares the budget for the thing that costs the workspace
 * money, while a shared office address cannot spend another tenant's. It runs
 * after the role check, so `organizationId` is the path's resolved value.
 */
export const monthlyReportIssueRateLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,
  windowMs: 60 * 60 * 1000,
  limit: 20,
  store: rateLimitStoreFor('monthly-report-issue'),
  keyGenerator: (request) => `org:${String(request.params.organizationId ?? clientKey(request))}`,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'That workspace has issued 20 reports this hour. Wait before issuing another.',
    },
  },
});

/**
 * Publishing a DNS record is a thirty-an-hour workspace operation.
 *
 * Keyed on the workspace because the cost and the provider rate limit belong to
 * the account, not to one staff member or one office address. It runs after the
 * role check, so organizationId is the path's resolved value.
 */
export const dnsPublishRateLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,
  windowMs: 60 * 60 * 1000,
  limit: 30,
  store: rateLimitStoreFor('dns-publish'),
  keyGenerator: (request) => `org:${String(request.params.organizationId ?? clientKey(request))}`,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'That workspace has published 30 DNS records this hour. Wait before publishing another.',
    },
  },
});

/**
 * The emailed report link is public, so it gets its own budget, per link.
 *
 * Keyed on the token rather than the address. Recipients open the link through
 * the web app's /reports/download route, which calls this API from the web
 * server, so every recipient arrives from the same address: a per-address
 * limit of 20 a minute was a limit of 20 downloads a minute for every client
 * of every agency, on the morning the scheduled reports go out. Guessing a
 * 256-bit token is not a threat a rate limit can add anything to, so the limit
 * only has to stop one link being hammered.
 */
export const publicMonthlyReportDownloadRateLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,
  windowMs: 60_000,
  limit: 20,
  store: rateLimitStoreFor('monthly-report-download'),
  keyGenerator: (request) => {
    const token = typeof request.query?.token === 'string' ? request.query.token.slice(0, 256) : '';
    return token ? `token:${createHash('sha256').update(token).digest('hex')}` : `ip:${clientKey(request)}`;
  },
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many download attempts. Wait a minute and try again.',
    },
  },
});

export const publicTrustCenterRateLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,
  windowMs: 60_000,
  limit: 30,
  store: rateLimitStoreFor('public-trust-center'),
  keyGenerator: clientKey,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Wait a minute and try again.',
    },
  },
});

export function createPublicReportRateLimiter(
  limit = env.PUBLIC_REPORT_RATE_LIMIT_PER_MINUTE,
): RateLimitRequestHandler {
  return rateLimit({
    ...SHARED_LIMITER_OPTIONS,
    windowMs: 60_000,
    limit,
    store: rateLimitStoreFor('public-report'),
    keyGenerator: clientKey,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many report views. Try again shortly.',
      },
    },
  });
}
