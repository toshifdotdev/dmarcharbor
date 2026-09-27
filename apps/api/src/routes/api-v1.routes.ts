import { Router } from 'express';
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
import { apiRateLimiter } from '../middleware/rate-limit.middleware.js';

// Declared with the full public path rather than mounted under a prefix, so the
// OpenAPI contract and the registered route are literally the same string and
// the contract drift test can compare them directly.
export const apiV1Router = Router();

apiV1Router.use(apiRateLimiter);

apiV1Router.get('/clients', requireApiKey('read'), listApiClientsController);
apiV1Router.post('/clients', requireApiKey('write'), createApiClientController);
apiV1Router.post('/clients/bulk', requireApiKey('write'), bulkClientsController);
apiV1Router.get('/domains', requireApiKey('read'), listApiDomainsController);
apiV1Router.post('/domains', requireApiKey('write'), createApiDomainController);
apiV1Router.post('/domains/bulk', requireApiKey('write'), bulkDomainsController);
apiV1Router.post('/domains/:domainId/verify', requireApiKey('write'), verifyApiDomainController);
