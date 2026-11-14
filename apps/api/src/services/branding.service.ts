import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { deleteStoredLogo, objectKeyFromLogoUrl, publicLogoUrl } from './branding/logo-storage.service.js';
import { recordAuditEvent } from './audit.service.js';
import { resolveEntitlements } from './entitlements/entitlement.service.js';
import { resolveTxtFresh } from '../scanner/dns.js';
import {
  AgencyDomainHostingError,
  agencyDomainHosting,
  checkAgencyDomain,
  clearedHosting,
  releaseAgencyHostname,
  type AgencyDomainHostingView,
} from './branding/agency-domain-hosting.service.js';

export const brandingVerificationHost = 'branding';

export interface ResolvedBranding {
  /** The agency name shown to their clients. */
  workspaceName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  customDomain: string | null;
  customDomainVerified: boolean;
  /**
   * True once `https://<customDomain>` has answered as this agency through us.
   * Verification proves ownership; this proves the domain actually serves our
   * pages, so links emailed to clients wait for it.
   */
  customDomainLive: boolean;
  /** True only when the portal should present the agency brand (logo and colours). */
  branded: boolean;
  /** True when the plan includes serving client pages on the agency's own domain. */
  customDomainLicensed: boolean;
  /**
   * The support address the agency publishes to its clients: the Reply-To on
   * client mail and the "Questions?" line in it. Null below white label.
   */
  supportEmail: string | null;
  /** The agency's https help page for its clients. Null below white label. */
  supportUrl: string | null;
  /**
   * The agency's own address client mail is sent from, such as
   * `reports@mail.wistholm.example`. Only once the email provider has
   * verified the domain and the plan includes custom domains (Admiralty);
   * null otherwise, and client mail then uses the shared address.
   */
  sendingAddress: string | null;
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

  // A bare hostname is what people type. The form asks for "portal.clientbrand.example"
  // because that is the thing the customer actually owns, so refusing it until the
  // user works out we wanted "https://" first is the tool showing through. Only
  // a value that already carries a scheme is left alone, and the scheme is
  // dropped either way: what is stored and looked up is the host.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: 'That is not a usable domain name, for example portal.clientbrand.example.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'The custom domain must be an http or https address.' };
  }

  // The URL parser has already stripped the scheme, port and path, and the
  // shared domain normaliser rejects anything containing those characters, so
  // the host is used directly rather than being passed back through it.
  const domain = parsed.hostname.toLowerCase();
  if (!domain || !domain.includes('.')) {
    return { error: 'That is not a usable domain name, for example portal.clientbrand.example.' };
  }

  return { domain };
}

/** Letters, digits and hyphens per label, at least two labels, each 1 to 63 long. */
const plainHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** True when a value holds a character below space or in the C1 range, which includes CR and LF. */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

const supportEmailExample = 'The support email must be one address, for example help@youragency.example.';

/**
 * The support address an agency publishes to its clients.
 *
 * It goes into a Reply-To header on every client message, so it has to be one
 * plain address and nothing a mail client could read as a second one: no
 * display name, no quotes or angle brackets, no comma or semicolon, and no
 * line break that could start another header. The domain is lowercased; the
 * part before the @ is kept as typed, because some mail systems treat it as
 * case sensitive.
 */
export function validateSupportEmail(value: string): { email: string } | { error: string } {
  const trimmed = value.trim();
  if (trimmed.length > 254 || hasControlCharacter(trimmed)) {
    return { error: supportEmailExample };
  }
  const match = /^([^\s@"<>,;:()\\[\]]{1,64})@([^\s@"<>,;:()\\[\]]+)$/.exec(trimmed);
  if (!match) {
    return { error: supportEmailExample };
  }
  const domain = match[2]!.toLowerCase();
  if (domain.length > 253 || !plainHostname.test(domain)) {
    return { error: supportEmailExample };
  }
  return { email: `${match[1]}@${domain}` };
}

/** The https page an agency's clients can use for help. */
export function validateSupportUrl(value: string): { url: string } | { error: string } {
  const trimmed = value.trim();
  if (trimmed.length > 500 || hasControlCharacter(trimmed)) {
    return { error: 'The support page must be a full https address of 500 characters or fewer.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'The support page must be a full https address.' };
  }
  if (parsed.protocol !== 'https:') {
    return { error: 'The support page must be a full https address.' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'The support page must not include a username or password.' };
  }
  const url = parsed.toString();
  if (url.length > 500) {
    return { error: 'The support page must be a full https address of 500 characters or fewer.' };
  }
  return { url };
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
  /** null or an empty string clears it. */
  supportEmail?: string | null;
  /** null or an empty string clears it. */
  supportUrl?: string | null;
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

  // The contact the agency publishes to its clients. Checked here, before
  // anything is saved, so one bad field does not leave the others half written.
  if (input.supportEmail !== undefined) {
    if (input.supportEmail === null || input.supportEmail.trim() === '') {
      data.brandSupportEmail = null;
    } else {
      const checked = validateSupportEmail(input.supportEmail);
      if ('error' in checked) {
        throw new BrandingError(checked.error);
      }
      data.brandSupportEmail = checked.email;
    }
  }

  if (input.supportUrl !== undefined) {
    if (input.supportUrl === null || input.supportUrl.trim() === '') {
      data.brandSupportUrl = null;
    } else {
      const checked = validateSupportUrl(input.supportUrl);
      if ('error' in checked) {
        throw new BrandingError(checked.error);
      }
      data.brandSupportUrl = checked.url;
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
    await deleteStoredLogo(objectKeyFromLogoUrl(previous.brandLogoUrl, input.organizationId));
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

  const removed = await deleteStoredLogo(objectKeyFromLogoUrl(organization.brandLogoUrl, organizationId));
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
    // The certificate first: if Cloudflare will not let it go, the stored id
    // is kept and nothing changes, because it is the only handle on it.
    await releaseAgencyHostnameOrRefuse(input.organizationId);
    await prisma.organization.update({
      where: { id: input.organizationId },
      data: { customDomain: null, customDomainToken: null, customDomainVerifiedAt: null, ...clearedHosting },
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

  /**
   * Never one of ours, or a name our hosted records use.
   *
   * The claim is stored before anything is proved, and an agency could name
   * the app's or the API's host, the hosted DNS zone or an mta-sts host. The
   * lookup that serves a brand only trusts a verified claim, but the claim
   * still held the name against us and showed in the public host answer.
   * Loaded lazily: the sending-domain module imports this one.
   */
  const { isOurDomain } = await import('./branding/sending-domain.service.js');
  if (isOurDomain(domain) || domain.startsWith('mta-sts.') || domain.split('.').some((label) => label.startsWith('_'))) {
    throw new BrandingError(
      'That address cannot be a portal address. Use a hostname on a domain your agency owns, for example portal.youragency.example.',
      'CUSTOM_DOMAIN_RESERVED',
      400,
    );
  }

  const token = randomBytes(16).toString('base64url');

  // A hostname claimed by another workspace is refused before anything is
  // let go, so a refused claim never costs the agency its current domain.
  const holder = await prisma.organization.findFirst({
    where: { customDomain: domain, id: { not: input.organizationId } },
    select: { id: true },
  });
  if (holder) {
    throw new BrandingError(
      'That domain is already claimed by another workspace. Each hostname can serve only one agency.',
      'CUSTOM_DOMAIN_TAKEN',
      409,
    );
  }
  await releaseAgencyHostnameOrRefuse(input.organizationId);

  try {
    await prisma.organization.update({
      where: { id: input.organizationId },
      data: { customDomain: domain, customDomainToken: token, customDomainVerifiedAt: null, ...clearedHosting },
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

/** The stored Cloudflare hostname, removed, or the change refused in the agency's words. */
async function releaseAgencyHostnameOrRefuse(organizationId: string): Promise<void> {
  try {
    await releaseAgencyHostname(organizationId);
  } catch (error) {
    if (error instanceof AgencyDomainHostingError) {
      throw new BrandingError(error.message, error.code, error.status);
    }
    throw error;
  }
}

export async function verifyCustomDomain(
  organizationId: string,
  actorUserId?: string | null,
): Promise<{ verified: boolean; lookupStatus: string; error?: string; hosting: AgencyDomainHostingView }> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { customDomain: true, customDomainToken: true, customDomainVerifiedAt: true },
  });

  if (!organization?.customDomain || !organization.customDomainToken) {
    throw new BrandingError('Set a custom domain before verifying it.');
  }

  const host = customDomainVerificationHost(organization.customDomain);
  const expected = customDomainVerificationValue(organization.customDomainToken);
  // From the zone's own nameservers first, as for a client domain's ownership
  // record. Verify pressed before the TXT existed made the recursive resolver
  // cache "no such record" for the zone's negative TTL (30 minutes on
  // Cloudflare), so Verify kept failing after the record was published
  // (session 14).
  const lookup = await resolveTxtFresh(host, organization.customDomain);
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

  // Once the ownership record is proven, the rest of the way: the certificate
  // (or the operator), the CNAME and whether it answers through us yet. Check
  // is pressed again for each step, so this runs every time, not only the first.
  const verifiedNow = verified || Boolean(organization.customDomainVerifiedAt);
  const hosting = verifiedNow ? await checkAgencyDomain(organizationId) : await agencyDomainHosting(organizationId);

  return {
    verified,
    lookupStatus: lookup.status,
    ...(lookup.error ? { error: lookup.error } : {}),
    hosting,
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
export function isUniqueConstraintViolation(error: unknown): boolean {
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
      customDomainLiveAt: true,
      brandSupportEmail: true,
      brandSupportUrl: true,
      sendingDomain: true,
      sendingLocalPart: true,
      sendingDomainVerifiedAt: true,
    },
  });

  const entitlements = await resolveEntitlements(organizationId);
  const licensed = entitlements.features['branding.whitelabel'] ?? false;
  // The custom domain is its own entitlement (Admiralty), separate from the
  // logo and colours (Harbor and up). A domain kept from Admiralty after a
  // downgrade stops being presented; it is not deleted.
  const domainLicensed = licensed && (entitlements.features['branding.customDomain'] ?? false);
  const domainVerified = Boolean(organization.customDomain && organization.customDomainVerifiedAt);

  // A logo is only ever served from our own origin. An agency pasted a URL is
  // dropped rather than rendered, because a client facing page that loads an
  // agency controlled image hands that agency the contact's IP, the time they
  // signed in and which client they opened.
  const storedLogo = objectKeyFromLogoUrl(organization.brandLogoUrl, organizationId);

  return {
    workspaceName: organization.name,
    logoUrl: licensed && storedLogo ? publicLogoUrl(storedLogo) : null,
    primaryColor: licensed ? organization.brandPrimaryColor : null,
    accentColor: licensed ? organization.brandAccentColor : null,
    customDomain: domainLicensed && domainVerified ? organization.customDomain : null,
    customDomainVerified: domainLicensed ? domainVerified : false,
    customDomainLive: domainLicensed && domainVerified && organization.customDomainLiveAt !== null,
    branded: licensed,
    customDomainLicensed: domainLicensed,
    // Published by the agency for its clients, so it is presented wherever the
    // brand is, and not at all below white label.
    supportEmail: licensed ? organization.brandSupportEmail : null,
    supportUrl: licensed ? organization.brandSupportUrl : null,
    // The same rule as the custom domain: the plan has to include it and the
    // provider has to have verified it. A domain kept after a downgrade stops
    // being used without being deleted, and mail goes back to the shared address.
    sendingAddress:
      domainLicensed && organization.sendingDomainVerifiedAt && organization.sendingDomain && organization.sendingLocalPart
        ? `${organization.sendingLocalPart}@${organization.sendingDomain}`
        : null,
  };
}
