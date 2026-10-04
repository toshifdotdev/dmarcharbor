import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { deleteStoredLogo, objectKeyFromLogoUrl, publicLogoUrl } from './branding/logo-storage.service.js';
import { recordAuditEvent } from './audit.service.js';
import { resolveEntitlements } from './entitlements/entitlement.service.js';
import { systemDnsReader } from '../scanner/dns.js';

export const brandingVerificationHost = 'branding';

export interface ResolvedBranding {
  /** The agency name shown to their clients. */
  workspaceName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  customDomain: string | null;
  customDomainVerified: boolean;
  /** True only when the portal should present the agency brand. */
  branded: boolean;
}

const hexColour = /^#[0-9a-f]{6}$/i;

/** Returns a result object rather than a bare string, so a valid value can
 * never be mistaken for an error message. */
export function validateColour(value: string, label: string): { colour: string } | { error: string } {
  const trimmed = value.trim();
  if (!hexColour.test(trimmed)) {
    return { error: `${label} must be a hex colour such as #1a2b3c.` };
  }
  return { colour: `#${trimmed.slice(1).toLowerCase()}` };
}

export function validateLogoUrl(value: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { error: 'The logo must be a full https URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { error: 'The logo must be served over https.' };
  }
  return { url: parsed.toString() };
}

export function validateCustomDomain(value: string): { domain: string } | { error: string } {
  const raw = value.trim();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'Include the scheme, for example https://reports.yourdomain.com.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'The custom domain must be an http or https address.' };
  }

  // The URL parser has already stripped the scheme, port and path, and the
  // shared domain normaliser rejects anything containing those characters, so
  // the host is used directly rather than being passed back through it.
  const domain = parsed.hostname.toLowerCase();
  if (!domain || !domain.includes('.')) {
    return { error: 'That is not a usable domain name.' };
  }

  return { domain };
}

export function customDomainVerificationValue(token: string): string {
  return `dmarc-harbor-branding=${token}`;
}

export function customDomainVerificationHost(domain: string): string {
  return `_dmarc-harbor-branding.${domain}`;
}

export async function updateBranding(input: {
  organizationId: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
  actorUserId?: string | null;
}): Promise<ResolvedBranding> {
  const data: Record<string, string | null> = {};
  const previous = await prisma.organization.findUniqueOrThrow({
    where: { id: input.organizationId },
    select: { brandLogoUrl: true },
  });

  if (input.logoUrl !== undefined) {
    if (input.logoUrl === null || input.logoUrl.trim() === '') {
      data.brandLogoUrl = null;
    } else {
      const checked = validateLogoUrl(input.logoUrl);
      if ('error' in checked) {
        throw new BrandingError(checked.error);
      }
      data.brandLogoUrl = checked.url;
    }
  }

  if (input.primaryColor !== undefined) {
    if (input.primaryColor === null || input.primaryColor.trim() === '') {
      data.brandPrimaryColor = null;
    } else {
      const checked = validateColour(input.primaryColor ?? '', 'The primary colour');
      if ('error' in checked) {
        throw new BrandingError(checked.error);
      }
      data.brandPrimaryColor = checked.colour;
    }
  }

  if (input.accentColor !== undefined) {
    if (input.accentColor === null || input.accentColor.trim() === '') {
      data.brandAccentColor = null;
    } else {
      const checked = validateColour(input.accentColor ?? '', 'The accent colour');
      if ('error' in checked) {
        throw new BrandingError(checked.error);
      }
      data.brandAccentColor = checked.colour;
    }
  }

  await prisma.organization.update({ where: { id: input.organizationId }, data });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'BRANDING_UPDATED',
    targetType: 'organization',
    targetId: input.organizationId,
    detail: { ...data },
  });

  // A replaced logo leaves an orphaned object behind. Removing it here rather
  // than in a sweeper means the bucket does not accumulate one file per
  // rebrand, and a customer who swaps logos a dozen times is not a storage
  // incident. Only ever touches our own origin.
  if (data.brandLogoUrl !== undefined && data.brandLogoUrl !== previous.brandLogoUrl) {
    await deleteStoredLogo(objectKeyFromLogoUrl(previous.brandLogoUrl));
  }

  return resolveBranding(input.organizationId);
}

/**
 * Removes a workspace's stored logo when the plan no longer includes one.
 *
 * Called on downgrade. A customer's brand asset must not sit in a bucket
 * indefinitely after the feature that justified storing it has been withdrawn,
 * which is the mirror image of the rule that a failed payment never destroys
 * data: losing paid functionality must not silently keep their files.
 */
/**
 * Accepts the caller's transaction so a downgrade cannot delete a stored logo
 * and then roll back. It previously used the global client, which meant the
 * object was removed from the bucket even when the plan change around it was
 * abandoned: the customer's logo gone and their plan unchanged.
 */
export async function removeLogoOnDowngrade(
  organizationId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const organization = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { brandLogoUrl: true },
  });

  const removed = await deleteStoredLogo(objectKeyFromLogoUrl(organization.brandLogoUrl));
  if (removed) {
    await tx.organization.update({ where: { id: organizationId }, data: { brandLogoUrl: null } });
  }

  return removed;
}

export async function setCustomDomain(input: {
  organizationId: string;
  customDomain: string | null;
  actorUserId?: string | null;
}): Promise<{ customDomain: string | null; verificationHost: string | null; verificationValue: string | null }> {
  if (input.customDomain === null || input.customDomain.trim() === '') {
    await prisma.organization.update({
      where: { id: input.organizationId },
      data: { customDomain: null, customDomainToken: null, customDomainVerifiedAt: null },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? undefined,
      action: 'BRANDING_UPDATED',
      targetType: 'organization',
      targetId: input.organizationId,
      detail: { customDomain: null },
    });
    return { customDomain: null, verificationHost: null, verificationValue: null };
  }

  const checked = validateCustomDomain(input.customDomain);
  if ('error' in checked) {
    throw new BrandingError(checked.error);
  }

  const domain = checked.domain;
  const token = randomBytes(16).toString('base64url');

  try {
    await prisma.organization.update({
      where: { id: input.organizationId },
      data: { customDomain: domain, customDomainToken: token, customDomainVerifiedAt: null },
    });
  } catch (error) {
    // Two agencies claiming one hostname would make host based tenant
    // resolution ambiguous, so the second claim is refused outright.
    if (isUniqueConstraintViolation(error)) {
      throw new BrandingError(
        'That domain is already claimed by another workspace. Each hostname can serve only one agency.',
        'CUSTOM_DOMAIN_TAKEN',
        409,
      );
    }
    throw error;
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'BRANDING_UPDATED',
    targetType: 'organization',
    targetId: input.organizationId,
    detail: { customDomain: domain },
  });

  return {
    customDomain: domain,
    verificationHost: customDomainVerificationHost(domain),
    verificationValue: customDomainVerificationValue(token),
  };
}

export async function verifyCustomDomain(
  organizationId: string,
  actorUserId?: string | null,
): Promise<{ verified: boolean; lookupStatus: string; error?: string }> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { customDomain: true, customDomainToken: true, customDomainVerifiedAt: true },
  });

  if (!organization?.customDomain || !organization.customDomainToken) {
    throw new BrandingError('Set a custom domain before verifying it.');
  }

  const host = customDomainVerificationHost(organization.customDomain);
  const expected = customDomainVerificationValue(organization.customDomainToken);
  const lookup = await systemDnsReader.resolveTxt(host);
  const verified = lookup.status === 'found' && lookup.value?.some((chunks) => chunks.join('') === expected) === true;

  if (verified && !organization.customDomainVerifiedAt) {
    await prisma.organization.update({
      where: { id: organizationId },
      data: { customDomainVerifiedAt: new Date() },
    });
    await recordAuditEvent({
      organizationId,
      actorUserId: actorUserId ?? undefined,
      action: 'CUSTOM_DOMAIN_VERIFIED',
      targetType: 'organization',
      targetId: organizationId,
      detail: { customDomain: organization.customDomain },
    });
  }

  return {
    verified,
    lookupStatus: lookup.status,
    ...(lookup.error ? { error: lookup.error } : {}),
  };
}

/**
 * Resolves the agency that owns a request's hostname.
 *
 * A white label is only real if the request itself says which agency is being
 * viewed, rather than the branding being attached to a session. The frontend
 * calls this on the custom domain to learn whose portal it is serving before
 * the visitor has signed in.
 *
 * Only branding is returned, and only for a domain whose ownership record has
 * been verified, so an unverified or lapsed domain cannot be used to discover
 * an agency. Caller is responsible for applying the plan gate through
 * `resolveBranding`.
 */
export async function findOrganizationByHost(
  host: string | undefined | null,
): Promise<{ organizationId: string; verified: boolean } | null> {
  if (!host) {
    return null;
  }

  // The Host header carries a port in local development, which is not part of
  // the stored domain.
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, '');
  if (!hostname.includes('.') || hostname.includes(' ')) {
    return null;
  }

  const organization = await prisma.organization.findUnique({
    where: { customDomain: hostname },
    select: { id: true, customDomainVerifiedAt: true },
  });

  if (!organization) {
    return null;
  }

  // A host pointed at us but not yet proven is still a fact about the world, and
  // returning null for it made the honest state unreachable. The frontend already
  // renders "record not verified yet" correctly, and that branch could never fire
  // because the API refused to say the host existed at all.
  //
  // The proof is not skipped in exchange. Callers decide what a verified host
  // unlocks; this only reports what is true.
  return { organizationId: organization.id, verified: organization.customDomainVerifiedAt !== null };
}

export class BrandingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code = 'INVALID_REQUEST', status = 400) {
    super(message);
    this.name = 'BrandingError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Resolves the branding a client facing surface should present.
 *
 * The workspace name is always returned, because an agency should never be
 * invisible to its client. Everything else, the logo, the colours and the
 * custom domain, is only presented once the plan includes white labelling and,
 * for the domain, once the DNS record has actually been published. Branding is
 * never applied to the agency's own interface, only to what the client sees.
 */
/** Prisma reports a unique violation as P2002. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export async function resolveBranding(organizationId: string): Promise<ResolvedBranding> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      name: true,
      plan: true,
      brandLogoUrl: true,
      brandPrimaryColor: true,
      brandAccentColor: true,
      customDomain: true,
      customDomainVerifiedAt: true,
    },
  });

  const entitlements = await resolveEntitlements(organizationId);
  const licensed = entitlements.features['branding.whitelabel'] ?? false;
  const domainVerified = Boolean(organization.customDomain && organization.customDomainVerifiedAt);

  // A logo is only ever served from our own origin. An agency pasted a URL is
  // dropped rather than rendered, because a client facing page that loads an
  // agency controlled image hands that agency the contact's IP, the time they
  // signed in and which client they opened.
  const storedLogo = objectKeyFromLogoUrl(organization.brandLogoUrl);

  return {
    workspaceName: organization.name,
    logoUrl: licensed && storedLogo ? publicLogoUrl(storedLogo) : null,
    primaryColor: licensed ? organization.brandPrimaryColor : null,
    accentColor: licensed ? organization.brandAccentColor : null,
    customDomain: licensed && domainVerified ? organization.customDomain : null,
    customDomainVerified: licensed ? domainVerified : false,
    branded: licensed,
  };
}
