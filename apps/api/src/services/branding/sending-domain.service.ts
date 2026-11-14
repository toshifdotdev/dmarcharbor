import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { addressOf, oneLine } from '../../email/sender.js';
import { recordAuditEvent } from '../audit.service.js';
import {
  BrandingError,
  agencyClaimLapsed,
  isUniqueConstraintViolation,
  unprovenAgencyClaimDays,
} from '../branding.service.js';
import { sendingDomainProvider, type ProviderDomain, type SendingDomainRecord } from './sending-domain-provider.js';

/**
 * An agency's own sending address for client mail (Admiralty).
 *
 * The agency names an address such as `reports@mail.wistholm.example`. Its
 * domain is added to our email provider account, the provider hands back the
 * DKIM and SPF records, the agency publishes them, and once the provider says
 * the domain is verified, client mail leaves from that address with the
 * agency's name in front. Until then, and whenever the provider stops saying
 * so, client mail keeps coming from the shared address with the agency's name,
 * which is what it did before the agency set anything.
 *
 * The agency's own DMARC record covers the sending subdomain by alignment, so
 * the agency's clients see mail that passes DMARC as the agency itself.
 */

export interface SendingDomainState {
  /** The stored `local@domain`, verified or not. */
  sendingAddress: string | null;
  /** The provider's last reported status, or null when none is set. */
  status: string | null;
  records: SendingDomainRecord[];
  /** True while the provider reports the domain verified. */
  verified: boolean;
}

/** One address on one plain hostname, lowercased; see `validateSendingAddress`. */
const localPartPattern = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const addressExample =
  'The sending address must be one address on your own domain, for example reports@mail.youragency.example.';

function hostnameOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function domainOfAddress(value: string | undefined | null): string | null {
  if (!value) return null;
  const address = addressOf(value);
  return address?.split('@')[1]?.toLowerCase() ?? null;
}

/**
 * Every domain this deployment sends from or serves.
 *
 * Read when asked rather than once at start-up, so a test that changes the
 * environment sees the change. That is the domains of EMAIL_FROM and
 * CLIENT_EMAIL_FROM_ADDRESS and the hosts of APP_URL, BETTER_AUTH_URL and every
 * CORS origin. The report mailboxes and the hosted DNS, BIMI and MTA-STS hosts
 * are ours as well, so they are refused for the same reason.
 */
export function ourDomains(): string[] {
  const found = [
    domainOfAddress(env.EMAIL_FROM),
    domainOfAddress(env.CLIENT_EMAIL_FROM_ADDRESS),
    domainOfAddress(env.REPORT_AGGREGATE_ADDRESS),
    domainOfAddress(env.REPORT_FORENSIC_ADDRESS),
    domainOfAddress(env.REPORT_TLSRPT_ADDRESS),
    hostnameOf(env.APP_URL),
    hostnameOf(env.BETTER_AUTH_URL),
    ...env.CORS_ORIGINS.map((origin) => hostnameOf(origin)),
    env.HOSTED_DNS_ZONE ?? null,
    env.HOSTED_MTA_STS_CNAME_TARGET ?? null,
    hostnameOf(env.HOSTED_BIMI_ORIGIN),
  ];
  return [...new Set(found.filter((domain): domain is string => Boolean(domain)))];
}

/**
 * True when `domain` is one of ours, a subdomain of one, or a parent of one.
 *
 * The domain is created in, and later removed from, our own provider account.
 * An agency naming ours, or one beneath it, could therefore have us add and
 * then delete the entry our own mail depends on. A parent of ours is refused
 * as well: no agency owns the zone our domains live in, and an entry for it in
 * our account is not one an agency should be able to create or remove.
 */
export function isOurDomain(domain: string): boolean {
  const candidate = domain.toLowerCase();
  return ourDomains().some(
    (ours) => candidate === ours || candidate.endsWith(`.${ours}`) || ours.endsWith(`.${candidate}`),
  );
}

/** True when a value holds a character below space or in the C1 range, which includes CR and LF. */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/**
 * The address an agency wants its client mail sent from.
 *
 * One plain address and nothing else, lowercased. The part before the @ is
 * letters, digits and `. _ + -`, starting and ending with a letter or digit.
 * The domain is a plain hostname with at least one dot, each label 1 to 63
 * long and 253 in all. A domain of ours is refused (see `isOurDomain`).
 */
export function validateSendingAddress(value: string): { localPart: string; domain: string } | { error: string } {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 320 || hasControlCharacter(trimmed)) {
    return { error: addressExample };
  }

  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return { error: addressExample };
  }
  const [localPart, domain] = parts as [string, string];

  if (!localPartPattern.test(localPart)) {
    return {
      error:
        'The part before the @ can use letters, digits, dots, hyphens, underscores and plus signs, and must start and end with a letter or digit.',
    };
  }
  if (domain.length > 253 || !hostnamePattern.test(domain)) {
    return { error: addressExample };
  }
  if (isOurDomain(domain)) {
    return { error: "That domain is ours, so it cannot be an agency's sending domain." };
  }

  return { localPart, domain };
}

/** The stored records, read back defensively: a malformed entry is dropped, not returned. */
export function storedSendingDomainRecords(value: Prisma.JsonValue | null | undefined): SendingDomainRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: SendingDomainRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.record !== 'string' ||
      typeof item.type !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.value !== 'string' ||
      typeof item.status !== 'string'
    ) {
      continue;
    }
    records.push({
      record: item.record,
      type: item.type,
      name: item.name,
      value: item.value,
      priority: typeof item.priority === 'number' ? item.priority : null,
      status: item.status,
    });
  }
  return records;
}

const stateSelect = {
  sendingDomain: true,
  sendingLocalPart: true,
  sendingDomainProviderId: true,
  sendingDomainStatus: true,
  sendingDomainRecords: true,
  sendingDomainVerifiedAt: true,
} as const;

type StoredSendingDomain = Prisma.OrganizationGetPayload<{ select: typeof stateSelect }>;

export function storedSendingAddress(row: { sendingDomain: string | null; sendingLocalPart: string | null }): string | null {
  return row.sendingDomain && row.sendingLocalPart ? `${row.sendingLocalPart}@${row.sendingDomain}` : null;
}

function stateOf(row: StoredSendingDomain): SendingDomainState {
  return {
    sendingAddress: storedSendingAddress(row),
    status: row.sendingDomain ? row.sendingDomainStatus : null,
    records: row.sendingDomain ? storedSendingDomainRecords(row.sendingDomainRecords) : [],
    verified: Boolean(row.sendingDomain && row.sendingDomainVerifiedAt),
  };
}

const emptyState: SendingDomainState = { sendingAddress: null, status: null, records: [], verified: false };

/** The provider's words in one plain sentence, for an agency to read. */
function providerFailure(domain: string, error: unknown): BrandingError {
  const detail = oneLine(error instanceof Error ? error.message : 'No reason was given.').replace(/\.+$/, '');
  return new BrandingError(
    `The email provider could not set up ${domain}: ${detail || 'no reason was given'}.`,
    'SENDING_DOMAIN_PROVIDER_ERROR',
    502,
  );
}

/**
 * Removes a domain from the provider account, and never throws.
 *
 * Used where the domain has already stopped mattering to us: it was replaced,
 * removed, lost a race for the name, or its workspace is being deleted. A
 * failure is logged for an operator to tidy by hand. Failing the agency's
 * request over it would leave their settings in a worse state than the entry
 * left behind in our account does.
 */
export async function removeProviderDomainQuietly(providerId: string | null | undefined): Promise<void> {
  if (!providerId) {
    return;
  }
  try {
    await sendingDomainProvider().remove(providerId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown provider error.';
    console.error(`[sending-domain] could not remove provider domain ${providerId}: ${detail}`);
  }
}

/** For the workspace deletion paths: read before the row goes, removed after. */
export async function sendingDomainProviderIdFor(organizationId: string): Promise<string | null> {
  const row = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { sendingDomainProviderId: true },
  });
  return row?.sendingDomainProviderId ?? null;
}

export async function setSendingAddress(input: {
  organizationId: string;
  address: string | null;
  actorUserId?: string | null;
}): Promise<SendingDomainState> {
  const current = await prisma.organization.findUniqueOrThrow({
    where: { id: input.organizationId },
    select: stateSelect,
  });

  // Removal is allowed on any plan, so a domain kept after a downgrade can be let go.
  if (input.address === null || input.address.trim() === '') {
    await prisma.organization.update({
      where: { id: input.organizationId },
      data: {
        sendingDomain: null,
        sendingLocalPart: null,
        sendingDomainProviderId: null,
        sendingDomainStatus: null,
        // A Json column is cleared with the database NULL sentinel, not `null`.
        sendingDomainRecords: Prisma.DbNull,
        sendingDomainVerifiedAt: null,
        sendingDomainCheckedAt: null,
        sendingDomainClaimedAt: null,
      },
    });
    await removeProviderDomainQuietly(current.sendingDomainProviderId);
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? undefined,
      action: 'BRANDING_UPDATED',
      targetType: 'organization',
      targetId: input.organizationId,
      detail: { sendingAddress: null },
    });
    return emptyState;
  }

  const checked = validateSendingAddress(input.address);
  if ('error' in checked) {
    throw new BrandingError(checked.error);
  }
  const { localPart, domain } = checked;
  const sendingAddress = `${localPart}@${domain}`;

  // The same domain with a different name before the @: the provider verifies
  // domains, not addresses, so the verification is kept.
  if (current.sendingDomain === domain && current.sendingDomainProviderId) {
    const updated = await prisma.organization.update({
      where: { id: input.organizationId },
      data: { sendingLocalPart: localPart },
      select: stateSelect,
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? undefined,
      action: 'BRANDING_UPDATED',
      targetType: 'organization',
      targetId: input.organizationId,
      detail: { sendingAddress },
    });
    return stateOf(updated);
  }

  // Asked before the provider is, so the usual case of a taken domain is a
  // plain 409 and never leaves an entry in the provider account. The unique
  // index below still decides a race between two workspaces.
  const holder = await prisma.organization.findFirst({
    where: { sendingDomain: domain, id: { not: input.organizationId } },
    select: { id: true, sendingDomainVerifiedAt: true, sendingDomainClaimedAt: true, sendingDomainProviderId: true },
  });
  if (holder && !(await releaseUnprovenSendingDomain(holder, domain))) {
    throw takenError();
  }

  const provider = sendingDomainProvider();
  let created: ProviderDomain;
  try {
    created = await provider.create(domain);
  } catch (error) {
    throw providerFailure(domain, error);
  }

  let saved: StoredSendingDomain;
  try {
    saved = await prisma.organization.update({
      where: { id: input.organizationId },
      data: {
        sendingDomain: domain,
        sendingLocalPart: localPart,
        sendingDomainProviderId: created.id,
        sendingDomainStatus: created.status,
        sendingDomainRecords: created.records as unknown as Prisma.InputJsonValue,
        sendingDomainVerifiedAt: null,
        sendingDomainCheckedAt: new Date(),
        sendingDomainClaimedAt: new Date(),
      },
      select: stateSelect,
    });
  } catch (error) {
    // Another workspace saved the same domain between the check above and here.
    // The entry this request just created is the loser's, so it goes.
    await removeProviderDomainQuietly(created.id);
    if (isUniqueConstraintViolation(error)) {
      throw takenError();
    }
    throw error;
  }

  // The previous domain is only let go once the new one is saved, so a failure
  // above leaves the agency exactly where it was.
  if (current.sendingDomainProviderId && current.sendingDomainProviderId !== created.id) {
    await removeProviderDomainQuietly(current.sendingDomainProviderId);
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'BRANDING_UPDATED',
    targetType: 'organization',
    targetId: input.organizationId,
    detail: { sendingAddress },
  });

  return stateOf(saved);
}

/**
 * Lets go of another workspace's sending domain when the provider never
 * verified it and the claim is older than two weeks, as for a custom domain
 * (branding.service.ts). True when the name is free now. The other workspace's
 * provider entry goes with it, and the change is in its audit trail.
 */
async function releaseUnprovenSendingDomain(
  holder: { id: string; sendingDomainVerifiedAt: Date | null; sendingDomainClaimedAt: Date | null; sendingDomainProviderId: string | null },
  domain: string,
): Promise<boolean> {
  if (holder.sendingDomainVerifiedAt || !agencyClaimLapsed(holder.sendingDomainClaimedAt)) {
    return false;
  }
  const released = await prisma.organization.updateMany({
    where: { id: holder.id, sendingDomain: domain, sendingDomainVerifiedAt: null },
    data: {
      sendingDomain: null,
      sendingLocalPart: null,
      sendingDomainProviderId: null,
      sendingDomainStatus: null,
      sendingDomainRecords: Prisma.DbNull,
      sendingDomainCheckedAt: null,
      sendingDomainClaimedAt: null,
    },
  });
  if (released.count !== 1) {
    return false;
  }
  await removeProviderDomainQuietly(holder.sendingDomainProviderId);
  await recordAuditEvent({
    organizationId: holder.id,
    action: 'BRANDING_UPDATED',
    targetType: 'organization',
    targetId: holder.id,
    detail: {
      sendingAddress: null,
      released: domain,
      reason: `Not verified, so the sending domain was released after ${unprovenAgencyClaimDays} days to another workspace that claimed it.`,
    },
  });
  return true;
}

function takenError(): BrandingError {
  return new BrandingError('That domain is already used for sending by another workspace.', 'SENDING_DOMAIN_TAKEN', 409);
}

/**
 * Asks the provider to look at the agency's records, and stores what it says.
 *
 * The first time the provider reports the domain verified, client mail starts
 * leaving from it and that is recorded in the audit trail. If the provider
 * later stops reporting it verified (the agency unpublished a record), the
 * verification is cleared and client mail goes back to the shared address with
 * the agency's name, rather than being refused by the provider.
 */
export async function checkSendingDomain(organizationId: string, actorUserId?: string | null): Promise<SendingDomainState> {
  const current = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: stateSelect });
  if (!current.sendingDomain || !current.sendingDomainProviderId) {
    throw new BrandingError('Set a sending address before checking it.');
  }
  const providerId = current.sendingDomainProviderId;
  const domain = current.sendingDomain;

  const provider = sendingDomainProvider();
  let answer: ProviderDomain;
  try {
    await provider.verify(providerId);
    answer = await provider.get(providerId);
  } catch (error) {
    throw providerFailure(domain, error);
  }

  const now = new Date();
  const verifiedNow = answer.status === 'verified';

  // Conditional on the provider id, so a check that finishes after the agency
  // changed the domain cannot write the old domain's answer onto the new one.
  const written = await prisma.organization.updateMany({
    where: { id: organizationId, sendingDomainProviderId: providerId },
    data: {
      sendingDomainStatus: answer.status,
      sendingDomainRecords: answer.records as unknown as Prisma.InputJsonValue,
      sendingDomainCheckedAt: now,
      ...(!verifiedNow ? { sendingDomainVerifiedAt: null } : {}),
    },
  });

  if (written.count === 1 && verifiedNow) {
    // Only the first check to see it verified sets the date and writes the
    // audit row, however many run at once.
    const flipped = await prisma.organization.updateMany({
      where: { id: organizationId, sendingDomainProviderId: providerId, sendingDomainVerifiedAt: null },
      data: { sendingDomainVerifiedAt: now },
    });
    if (flipped.count === 1) {
      await recordAuditEvent({
        organizationId,
        actorUserId: actorUserId ?? undefined,
        action: 'SENDING_DOMAIN_VERIFIED',
        targetType: 'organization',
        targetId: organizationId,
        detail: { sendingDomain: domain },
      });
    }
  }

  const after = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: stateSelect });
  return stateOf(after);
}
