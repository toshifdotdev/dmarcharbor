import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import {
  BrandingError,
  findOrganizationByHost,
  resolveBranding,
  setCustomDomain,
  updateBranding,
  verifyCustomDomain,
} from '../services/branding.service.js';
import { EntitlementError, assertFeature } from '../services/entitlements/entitlement.service.js';

const brandingSchema = z.object({
  logoUrl: z.string().max(500).nullable().optional(),
  primaryColor: z.string().max(7).nullable().optional(),
  accentColor: z.string().max(7).nullable().optional(),
});

const domainSchema = z.object({
  customDomain: z.string().trim().max(300).nullable(),
});

function sendBrandingError(response: Response, error: unknown): void {
  if (error instanceof BrandingError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof EntitlementError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL', message: 'Branding could not be updated.' } });
}

/**
 * Resolves which agency a hostname belongs to, for a visitor who has not
 * signed in yet.
 *
 * This is deliberately unauthenticated and deliberately narrow: it returns the
 * branding for a verified custom domain and nothing else. No clients, no
 * domains, no counts, and no agency identifier beyond the display name the
 * agency chose to publish.
 */
export async function resolveBrandingByHostController(request: Request, response: Response): Promise<void> {
  try {
    const organizationId = await findOrganizationByHost(request.get('host'));
    if (!organizationId) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'No agency is served on this address.' } });
      return;
    }

    response.json(await resolveBranding(organizationId));
  } catch (error) {
    sendBrandingError(response, error);
  }
}

export async function getBrandingController(_request: Request, response: Response): Promise<void> {
  response.json(await resolveBranding(response.locals.organizationId));
}

export async function updateBrandingController(request: Request, response: Response): Promise<void> {
  const body = brandingSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Provide a logo URL and hex colours.' } });
    return;
  }

  const organizationId = response.locals.organizationId;

  try {
    await assertFeature(organizationId, 'branding.whitelabel');
    const branding = await updateBranding({
      organizationId,
      ...body.data,
      actorUserId: response.locals.session?.user?.id,
    });
    response.json(branding);
  } catch (error) {
    sendBrandingError(response, error);
  }
}

export async function setCustomDomainController(request: Request, response: Response): Promise<void> {
  const body = domainSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Provide a custom domain URL or null.' } });
    return;
  }

  const organizationId = response.locals.organizationId;

  try {
    await assertFeature(organizationId, 'branding.whitelabel');
    const result = await setCustomDomain({
      organizationId,
      customDomain: body.data.customDomain,
      actorUserId: response.locals.session?.user?.id,
    });

    response.json({
      ...result,
      notice: result.customDomain
        ? 'Publish the TXT record at your DNS host, then verify. The custom domain is not used until it is verified.'
        : 'The custom domain has been removed.',
    });
  } catch (error) {
    sendBrandingError(response, error);
  }
}

export async function verifyCustomDomainController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;

  try {
    await assertFeature(organizationId, 'branding.whitelabel');
    response.json(await verifyCustomDomain(organizationId, response.locals.session?.user?.id));
  } catch (error) {
    sendBrandingError(response, error);
  }
}

/**
 * What a client contact should render. Resolved from the portal scope, so a
 * contact always sees their own agency's branding and never another one.
 */
export async function portalBrandingController(_request: Request, response: Response): Promise<void> {
  response.json(await resolveBranding(response.locals.organizationId));
}

/** Raw branding row, for the agency interface only. Never exposed to a contact. */
export async function getStoredBrandingController(_request: Request, response: Response): Promise<void> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: response.locals.organizationId },
    select: {
      brandLogoUrl: true,
      brandPrimaryColor: true,
      brandAccentColor: true,
      customDomain: true,
      customDomainVerifiedAt: true,
    },
  });

  response.json(organization);
}
