import express, { Router } from 'express';
import {
  checkHostedBimiController,
  deleteHostedBimiCertificateController,
  getHostedBimiController,
  releaseHostedBimiController,
  startHostedBimiController,
  uploadHostedBimiCertificateController,
  uploadHostedBimiLogoController,
} from '../controllers/hosted-bimi.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { dnsPublishRateLimiter } from '../middleware/rate-limit.middleware.js';

/**
 * Raw bodies for the two uploads, as in branding.routes.ts.
 *
 * `express.raw` rather than `json`: the payload is a file. Each limit is just
 * over the largest accepted file, so an oversized upload is refused here for
 * the reason "too large" rather than arriving whole and being rejected further
 * in. The SVG limit matches the 32,768-byte check exactly; the certificate
 * limit leaves room for a full chain.
 */
const logoBody = express.raw({ limit: '33kb', type: ['image/svg+xml'] });
const certificateBody = express.raw({
  limit: '64kb',
  type: ['application/x-pem-file', 'application/pem-certificate-chain', 'text/plain'],
});
const json = express.json({ limit: '8kb' });

/**
 * Hosted BIMI.
 *
 * Starting and every upload or removal are the paid feature. Reading, checking
 * and releasing are not gated: a downgraded workspace must still see the record
 * it keeps serving, and must always be able to leave.
 */
export const hostedBimiRouter = Router();

hostedBimiRouter.get(
  '/workspaces/:organizationId/domains/:domainId/hosted-bimi',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  getHostedBimiController,
);

hostedBimiRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-bimi',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hostedBimi'),
  dnsPublishRateLimiter,
  startHostedBimiController,
);

hostedBimiRouter.put(
  '/workspaces/:organizationId/domains/:domainId/hosted-bimi/logo',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hostedBimi'),
  dnsPublishRateLimiter,
  logoBody,
  uploadHostedBimiLogoController,
);

hostedBimiRouter.put(
  '/workspaces/:organizationId/domains/:domainId/hosted-bimi/certificate',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hostedBimi'),
  dnsPublishRateLimiter,
  certificateBody,
  uploadHostedBimiCertificateController,
);

hostedBimiRouter.delete(
  '/workspaces/:organizationId/domains/:domainId/hosted-bimi/certificate',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('dns.hostedBimi'),
  deleteHostedBimiCertificateController,
);

hostedBimiRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-bimi/check',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  checkHostedBimiController,
);

hostedBimiRouter.post(
  '/workspaces/:organizationId/domains/:domainId/hosted-bimi/release',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  json,
  releaseHostedBimiController,
);
