import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { agencyForOrigin } from '../auth/agency-origin.js';
import { env } from '../config/env.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths a third party posts to on purpose, each with its own credential: an
 * identity provider's SAML form, the payment providers' signed webhooks, the
 * report ingest worker's signed calls, API keys, and Better Auth, which runs
 * its own origin check on every state-changing request.
 */
const EXEMPT_PATHS = [
  /^\/api\/sso\/[^/]+\/saml\/acs\/?$/i,
  /^\/api\/webhooks\//i,
  /^\/api\/internal\//i,
  /^\/api\/v1\//i,
  /^\/api\/auth\//i,
];

function webOrigins(): Set<string> {
  const origins = new Set(env.CORS_ORIGINS);
  try {
    origins.add(new URL(env.APP_URL).origin);
  } catch {
    // A malformed APP_URL fails env validation long before this runs.
  }
  return origins;
}

/**
 * Cross-site request forgery, for the routes that authenticate by cookie.
 *
 * The session cookie is SameSite=Lax, which keeps it off requests from other
 * sites, but not off requests from the same site: any other subdomain of our
 * domain counts, including a host serving uploaded files. CORS only withholds
 * the response from such a page; the request itself still runs, and a form
 * post or a text/plain fetch needs no preflight. So a state-changing request
 * that carries the cookie must also name an origin we serve the app from: our
 * own web origin, or an agency's verified custom domain.
 *
 * A request with no Origin header is not a browser being tricked (browsers
 * send it on every cross-origin request that can change state): it is our web
 * server calling from the server side, or a script holding the cookie itself.
 */
export function requireTrustedOrigin(): RequestHandler {
  const trusted = webOrigins();
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      next();
      return;
    }
    const origin = request.get('origin');
    if (origin === undefined || !request.headers.cookie) {
      next();
      return;
    }
    const path = (request.originalUrl ?? request.url).split('?')[0] ?? '';
    if (EXEMPT_PATHS.some((pattern) => pattern.test(path))) {
      next();
      return;
    }
    if (trusted.has(origin)) {
      next();
      return;
    }
    const agency = await agencyForOrigin(origin).catch(() => null);
    if (agency) {
      next();
      return;
    }
    response.status(403).json({
      error: {
        code: 'ORIGIN_REFUSED',
        message: 'This request came from a page this service does not serve, so it was not carried out.',
      },
    });
  };
}
