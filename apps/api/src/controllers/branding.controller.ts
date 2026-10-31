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
import { clientOrigin } from '../services/client-origin.js';
import { EntitlementError, assertFeature } from '../services/entitlements/entitlement.service.js';
import { LogoStorageError, createLogoUploadUrl, publicLogoUrl, uploadLogoDirect } from '../services/branding/logo-storage.service.js';
import { zodMessage } from '../utils/zod-messages.js';
import { updateBranding as updateBrandingSettings } from '../services/branding.service.js';
import {
  checkSendingDomain,
  setSendingAddress,
  storedSendingAddress,
  storedSendingDomainRecords,
} from '../services/branding/sending-domain.service.js';

/**
 * The support fields are bounded loosely here and checked exactly in the
 * service, so a value that is too long gets the service's plain sentence
 * rather than this controller's generic one.
 */
const brandingSchema = z.object({
  logoUrl: z.string().max(500).nullable().optional(),
  primaryColor: z.string().max(7).nullable().optional(),
  accentColor: z.string().max(7).nullable().optional(),
  supportEmail: z.string().max(320).nullable().optional(),
  supportUrl: z.string().max(1000).nullable().optional(),
});

const sendingDomainSchema = z.object({
  address: z.string().max(320).nullable(),
});

const domainSchema = z.object({
  customDomain: z.string().trim().max(300).nullable(),
});

const logoUploadSchema = z.object({
  contentType: z.string().min(1).max(80),
  byteSize: z.number().int().positive(),
});

const logoConfirmSchema = z.object({
  objectKey: z.string().min(1).max(300),
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
    const found = await findOrganizationByHost(request.get('host'));
    if (!found) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'No agency is served on this address.' } });
      return;
    }

    // An unverified host is answered, not refused. The record exists and the
    // domain is pointed at us, so saying so is the honest answer and it is what
    // lets the frontend show "not verified yet" instead of silently falling back
    // to the default brand, which read as the branding being live when it was not.
    // A domain kept from a plan that included it, on a plan that no longer
    // does, is answered as no agency at all. Without this the raw DNS state
    // below would mark it verified and the web app would serve the agency's
    // brand on it, which is the Admiralty feature itself.
    const branding = await resolveBranding(found.organizationId);
    if (!branding.customDomainLicensed) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'No agency is served on this address.' } });
      return;
    }

    response.json({
      ...branding,
      customDomainVerified: found.verified,
    });
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
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Provide a logo URL, hex colours, a support email and a support page, each as text or null.',
      },
    });
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
    // Removing a kept domain is allowed on any plan; claiming one needs Admiralty.
    if (body.data.customDomain) {
      await assertFeature(organizationId, 'branding.customDomain');
    }
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
    await assertFeature(organizationId, 'branding.customDomain');
    response.json(await verifyCustomDomain(organizationId, response.locals.session?.user?.id));
  } catch (error) {
    sendBrandingError(response, error);
  }
}

/**
 * Sets, changes or removes the agency's own sending address for client mail.
 *
 * Claiming one needs the custom domain entitlement (Admiralty); removing a
 * kept one is allowed on any plan, as for the custom domain. The answer carries
 * the DNS records to publish, and client mail keeps leaving from the shared
 * address until the provider has seen them.
 */
export async function setSendingDomainController(request: Request, response: Response): Promise<void> {
  const body = sendingDomainSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Provide a sending address, for example reports@mail.youragency.example, or null to remove it.',
      },
    });
    return;
  }

  const organizationId = response.locals.organizationId;

  try {
    if (body.data.address && body.data.address.trim() !== '') {
      await assertFeature(organizationId, 'branding.customDomain');
    }
    const result = await setSendingAddress({
      organizationId,
      address: body.data.address,
      actorUserId: response.locals.session?.user?.id,
    });

    response.json({
      ...result,
      notice: !result.sendingAddress
        ? 'Client email comes from the shared address with your name again.'
        : result.verified
          ? `Client email comes from ${result.sendingAddress}.`
          : 'Publish these records at your DNS host, then check them. Client email keeps coming from the shared address with your name until they are verified.',
    });
  } catch (error) {
    sendBrandingError(response, error);
  }
}

/** Asks the email provider to check the agency's sending domain records now. */
export async function verifySendingDomainController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;

  try {
    await assertFeature(organizationId, 'branding.customDomain');
    response.json(await checkSendingDomain(organizationId, response.locals.session?.user?.id));
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

/**
 * Raw branding row, for the agency interface only. Never exposed to a contact.
 *
 * `clientOrigin` is where the links this workspace's clients receive point:
 * `https://` and the custom domain once it is licensed and verified, APP_URL
 * otherwise. The settings page shows it so the agency knows which address its
 * clients are given.
 */
export async function getStoredBrandingController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId as string;
  const [organization, origin] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        brandLogoUrl: true,
        brandPrimaryColor: true,
        brandAccentColor: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        brandSupportEmail: true,
        brandSupportUrl: true,
        sendingDomain: true,
        sendingLocalPart: true,
        sendingDomainStatus: true,
        sendingDomainRecords: true,
        sendingDomainVerifiedAt: true,
        sendingDomainCheckedAt: true,
      },
    }),
    clientOrigin(organizationId),
  ]);

  // Built field by field, so the provider's id for the sending domain, which
  // is ours and not the agency's, can never reach the response by a wider select.
  const hasSendingDomain = Boolean(organization.sendingDomain);
  response.json({
    brandLogoUrl: organization.brandLogoUrl,
    brandPrimaryColor: organization.brandPrimaryColor,
    brandAccentColor: organization.brandAccentColor,
    customDomain: organization.customDomain,
    customDomainVerifiedAt: organization.customDomainVerifiedAt,
    brandSupportEmail: organization.brandSupportEmail,
    brandSupportUrl: organization.brandSupportUrl,
    sendingAddress: storedSendingAddress(organization),
    sendingDomainStatus: hasSendingDomain ? organization.sendingDomainStatus : null,
    sendingDomainRecords: hasSendingDomain ? storedSendingDomainRecords(organization.sendingDomainRecords) : [],
    sendingDomainVerifiedAt: hasSendingDomain ? organization.sendingDomainVerifiedAt : null,
    sendingDomainCheckedAt: hasSendingDomain ? organization.sendingDomainCheckedAt : null,
    clientOrigin: origin,
  });
}

/* ------------------------------------------------------------------- logo */

/**
 * Issues a presigned upload URL.
 *
 * The file never reaches this server. Content type and size are checked here
 * because that is the last point at which an upload can be constrained: a
 * presigned URL cannot be revoked once it has been handed out, so validating
 * after the upload would leave the object reachable and the check pointless.
 */
export async function createLogoUploadController(request: Request, response: Response): Promise<void> {
  const body = logoUploadSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: zodMessage(body.error.issues) ?? 'A content type and size are required.' } });
    return;
  }

  try {
    response.status(201).json(
      await createLogoUploadUrl({
        organizationId: response.locals.organizationId,
        contentType: body.data.contentType,
        byteSize: body.data.byteSize,
      }),
    );
  } catch (error) {
    if (error instanceof LogoStorageError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL', message: 'The logo could not be prepared for upload.' } });
  }
}

/**
 * Stores a logo sent as a raw request body, and records it in one step.
 *
 * This is the path the console uses. A presigned URL is still available and
 * still works, but it makes a small upload depend on a cross-origin request to
 * storage: a preflight, a signature, and headers only the sending browser
 * controls. When those disagreed the operator saw "Failed to fetch" and the
 * server had nothing to log, because the request never arrived here at all.
 *
 * Taking the bytes on our own origin removes the whole class. It also removes
 * the orphaned-object leak a two-step presign leaves behind: an upload that was
 * never confirmed used to sit in the bucket forever.
 */
export async function uploadLogoDirectController(request: Request, response: Response): Promise<void> {
  const contentType = request.get('content-type') ?? '';
  // The bytes, not the claim about them.
  const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

  try {
    const stored = await uploadLogoDirect({
      organizationId: response.locals.organizationId,
      contentType,
      bytes,
    });

    response.status(201).json({
      objectKey: stored.objectKey,
      logoUrl: stored.publicUrl,
      branding: await resolveBranding(response.locals.organizationId),
    });
  } catch (error) {
    if (error instanceof LogoStorageError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL', message: 'The logo could not be stored.' } });
  }
}

/**
 * Records an uploaded logo as this workspace's logo.
 *
 * Separate from issuing the URL, because uploading and saving are different
 * steps. An object can exist while the agency never confirms it, which is an
 * orphan rather than a branding setting, and the lifecycle rule sweeps those.
 */
export async function confirmLogoUploadController(request: Request, response: Response): Promise<void> {
  const body = logoConfirmSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: zodMessage(body.error.issues) ?? 'An object key is required.' } });
    return;
  }

  try {
    // A key from outside this workspace is refused, or a tenant could point its
    // portal at another tenant's asset.
    if (!body.data.objectKey.startsWith(`logos/${response.locals.organizationId}/`)) {
      response.status(404).json({ error: { code: 'OBJECT_NOT_FOUND', message: 'That upload does not belong to this workspace.' } });
      return;
    }

    await updateBrandingSettings({
      organizationId: response.locals.organizationId,
      actorUserId: response.locals.session?.user?.id,
      logoUrl: publicLogoUrl(body.data.objectKey),
    });

    response.json(await resolveBranding(response.locals.organizationId));
  } catch (error) {
    sendBrandingError(response, error);
  }
}
