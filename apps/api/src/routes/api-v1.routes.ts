import { Router, type RequestHandler } from 'express';
import {
  apiAcknowledgeAlertController,
  apiAcknowledgeDnsChangeController,
  apiCreateDomainScanController,
  apiGetDomainController,
  apiListAlertsController,
  apiListDnsChangesController,
  apiListDomainReportsController,
  apiListDomainScansController,
  apiListDomainSendersController,
  apiMeController,
  apiMoveDomainController,
  apiPolicyReadinessController,
  apiTlsSummaryController,
  bulkClientsController,
  bulkDomainsController,
  createApiClientController,
  createApiDomainController,
  listApiClientsController,
  listApiDomainsController,
  verifyApiDomainController,
} from '../controllers/api-v1.controller.js';
import { requireApiKey } from '../middleware/api-auth.middleware.js';
import {
  apiRateLimiter,
  createApiKeyRateLimiter,
  createScanRateLimiter,
} from '../middleware/rate-limit.middleware.js';
import type { ApiScope } from '../services/api-key.service.js';
import { apiUsageController } from '../controllers/usage-export.controller.js';

// Mounted at /api/v1, and every path below is declared relative to that. The
// contract in openapi.ts is keyed on '/v1/...' and the drift test applies this
// mount point, so a route registered here and a path documented there are the
// same string once the prefix is added.
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

/**
 * The scan route carries the same on-demand budget as the browser button.
 *
 * `createScanRateLimiter` is per address rather than per key, and it is mounted
 * here on purpose: a key with `write` should not be able to turn one workspace
 * into a DNS amplifier by calling the scan endpoint in a loop. The API's own
 * per-key limiter still applies on top.
 */
function scanRoute(handler: RequestHandler): RequestHandler[] {
  return [requireApiKey('write'), apiKeyRateLimiter, createScanRateLimiter(), handler];
}

// ─── Existing surface (paths, scopes and shapes unchanged) ───────────────────

apiV1Router.get('/clients', ...apiRoute('read', listApiClientsController));
apiV1Router.post('/clients', ...apiRoute('write', createApiClientController));
apiV1Router.post('/clients/bulk', ...apiRoute('write', bulkClientsController));
apiV1Router.get('/domains', ...apiRoute('read', listApiDomainsController));
apiV1Router.post('/domains', ...apiRoute('write', createApiDomainController));
apiV1Router.post('/domains/bulk', ...apiRoute('write', bulkDomainsController));
apiV1Router.post('/domains/:domainId/verify', ...apiRoute('write', verifyApiDomainController));
// Basic operations: move a domain to another client, for a PSA sync.
apiV1Router.post('/domains/:domainId/move', ...apiRoute('write', apiMoveDomainController));

// ─── Item 16 additions ───────────────────────────────────────────────────────

apiV1Router.get('/me', ...apiRoute('read', apiMeController));

/**
 * `:domain` accepts an id or a slug, resolved inside the key's workspace. The
 * parameter is deliberately not called `:domainId` — it is not necessarily an id,
 * and naming it one would invite a caller to assume the list's ids are the only
 * thing that works.
 */
apiV1Router.get('/domains/:domain', ...apiRoute('read', apiGetDomainController));
apiV1Router.get('/domains/:domain/scans', ...apiRoute('read', apiListDomainScansController));
apiV1Router.post('/domains/:domain/scans', ...scanRoute(apiCreateDomainScanController));
apiV1Router.get('/domains/:domain/reports', ...apiRoute('read', apiListDomainReportsController));
apiV1Router.get('/domains/:domain/senders', ...apiRoute('read', apiListDomainSendersController));
apiV1Router.get('/domains/:domain/policy-readiness', ...apiRoute('read', apiPolicyReadinessController));
apiV1Router.get('/domains/:domain/tls-reports/summary', ...apiRoute('read', apiTlsSummaryController));

apiV1Router.get('/alerts', ...apiRoute('read', apiListAlertsController));

// Per-client usage for one month, for billing integrations (reports.usageExport).
apiV1Router.get('/usage', ...apiRoute('read', apiUsageController));
apiV1Router.post('/alerts/:alertId/acknowledge', ...apiRoute('write', apiAcknowledgeAlertController));

apiV1Router.get('/dns-changes', ...apiRoute('read', apiListDnsChangesController));
apiV1Router.post('/dns-changes/:changeId/acknowledge', ...apiRoute('write', apiAcknowledgeDnsChangeController));
