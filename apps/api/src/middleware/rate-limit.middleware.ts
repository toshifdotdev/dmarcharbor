import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * Counter store.
 *
 * Deliberately the default in-memory store for now. Two consequences, both
 * known and both accepted until a shared store is wired: counters reset on
 * every deploy, and behind N replicas the effective global limit is `limit * N`.
 * The failure mode of moving to a shared store later is that every key becomes
 * `ip:127.0.0.1` unless `trust proxy` is configured, so item 9 below is the
 * prerequisite for that change, not an optional extra.
 */
const store = undefined;

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

export const scanRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store,
  keyGenerator: clientKey,
});

export const reportIngestRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store,
  keyGenerator: clientKey,
});

export const secureSessionRouterRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store,
  keyGenerator: clientKey,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many security requests. Wait a minute and try again.',
    },
  },
});

/**
 * Sign-in, sign-up, password reset and email verification.
 *
 * Better Auth ships its own limiter but it is per-instance in-memory and resets
 * on deploy, so behind a load balancer the effective limit is multiplied by the
 * replica count and reset to full on every release. There is no MFA in this
 * product by decision, which makes this the primary brake on credential
 * stuffing and password spraying rather than a defence in depth extra.
 *
 * Mounted ahead of the Better Auth handler, so it applies to every auth path
 * including the social sign-in start.
 */
export function createAuthRateLimiter(limit = env.AUTH_RATE_LIMIT_PER_MINUTE): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store,
    keyGenerator: clientKey,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many sign-in attempts. Wait a minute and try again.',
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
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store,
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
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store,
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
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store,
  keyGenerator: clientKey,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many verification attempts. Wait a minute and try again.',
    },
  },
});

export const publicReportRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store,
  keyGenerator: clientKey,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many report views. Try again shortly.',
    },
  },
});