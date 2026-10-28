import express, { Router } from 'express';
import {
  deletePsaController,
  getPsaController,
  listPsaJobsController,
  listPsaMappingsController,
  patchPsaController,
  psaCompaniesController,
  psaOptionsController,
  removePsaMappingController,
  retryPsaJobController,
  savePsaController,
  setPsaMappingController,
  testPsaController,
} from '../controllers/psa.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { psaRateLimiter } from '../middleware/rate-limit.middleware.js';

const json = express.json({ limit: '16kb' });

/**
 * PSA ticketing.
 *
 * Gated only where it creates or changes a connection or a mapping. Reading,
 * disabling, deleting, removing a mapping and the job log are never gated: a
 * workspace that has downgraded must still be able to see what it configured
 * and take it apart, and the job log is how it finds out what happened to the
 * tickets it already has.
 *
 * `requireSession` is applied per route, never with `router.use`: this router is
 * mounted at /api, so a `use` here would run for every request entering it,
 * matching route or not.
 */
export const psaRouter = Router();

psaRouter.get(
  '/workspaces/:organizationId/psa',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  getPsaController,
);

psaRouter.put(
  '/workspaces/:organizationId/psa',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('integrations.psa'),
  json,
  savePsaController,
);

psaRouter.patch(
  '/workspaces/:organizationId/psa',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  json,
  patchPsaController,
);

psaRouter.delete(
  '/workspaces/:organizationId/psa',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  deletePsaController,
);

psaRouter.post(
  '/workspaces/:organizationId/psa/test',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('integrations.psa'),
  psaRateLimiter,
  testPsaController,
);

psaRouter.get(
  '/workspaces/:organizationId/psa/options',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  requireFeature('integrations.psa'),
  psaRateLimiter,
  psaOptionsController,
);

psaRouter.get(
  '/workspaces/:organizationId/psa/companies',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  requireFeature('integrations.psa'),
  psaRateLimiter,
  psaCompaniesController,
);

psaRouter.get(
  '/workspaces/:organizationId/psa/mappings',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  listPsaMappingsController,
);

psaRouter.put(
  '/workspaces/:organizationId/psa/mappings/:clientId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('integrations.psa'),
  json,
  setPsaMappingController,
);

psaRouter.delete(
  '/workspaces/:organizationId/psa/mappings/:clientId',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  removePsaMappingController,
);

psaRouter.get(
  '/workspaces/:organizationId/psa/jobs',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  listPsaJobsController,
);

psaRouter.post(
  '/workspaces/:organizationId/psa/jobs/:jobId/retry',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('integrations.psa'),
  retryPsaJobController,
);
