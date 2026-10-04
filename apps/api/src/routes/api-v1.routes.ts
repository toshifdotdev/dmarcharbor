import { Router, type RequestHandler } from 'express';
import {
  bulkClientsController,
  bulkDomainsController,
  createApiClientController,
  createApiDomainController,
  listApiClientsController,
  listApiDomainsController,
  verifyApiDomainController,
} from '../controllers/api-v1.controller.js';
import { requireApiKey } from '../middleware/api-auth.middleware.js';
import { apiRateLimiter, createApiKeyRateLimiter } from '../middleware/rate-limit.middleware.js';
import type { ApiScope } from '../services/api-key.service.js';

// Declared with the full public path rather than mounted under a prefix, so the
// OpenAPI contract and the registered route are literally the same string and
// the contract drift test can compare them directly.
export const apiV1Router = Router();

/**
 * Two limits, deliberately, because they defend against different things.
 *
 * The router-level limiter runs before any credential is checked and is keyed on
 * the client address, so it stops an unauthenticated caller driving an unbounded
 * number of key lookups. The per-key limiter runs after `requireApiKey` and is
 * keyed on the resolved key id, so it is the tenant's actual budget and one
 * workspace cannot spend another's.
 *
 * The per-key limiter has to come second because it needs `response.locals
 * .apiKeyId`, which only exists once the key has been resolved. The previous
 * single limiter keyed on the last 24 characters of the Authorization header,
 * a value an attacker controls and can vary per request, so it never actually
 * limited anyone.
 */
const apiKeyRateLimiter = createApiKeyRateLimiter();
apiV1Router.use(apiRateLimiter);

function apiRoute(scope: ApiScope, handler: RequestHandler): RequestHandler[] {
  return [requireApiKey(scope), apiKeyRateLimiter, handler];
}

apiV1Router.get('/clients', ...apiRoute('read', listApiClientsController));
apiV1Router.post('/clients', ...apiRoute('write', createApiClientController));
apiV1Router.post('/clients/bulk', ...apiRoute('write', bulkClientsController));
apiV1Router.get('/domains', ...apiRoute('read', listApiDomainsController));
apiV1Router.post('/domains', ...apiRoute('write', createApiDomainController));
apiV1Router.post('/domains/bulk', ...apiRoute('write', bulkDomainsController));
apiV1Router.post('/domains/:domainId/verify', ...apiRoute('write', verifyApiDomainController));