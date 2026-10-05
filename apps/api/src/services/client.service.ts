import { domainSlug } from './domain-slug.js';
import { prisma } from '../database/prisma.js';
import { emitEvent } from './webhook.service.js';
import { sendDomainVerificationEmail } from '../email/mailer.js';
import { normalizeDomain } from '../scanner/domain.js';
import { systemDnsReader } from '../scanner/dns.js';
import type { CreateClientRequest, CreateDomainRequest } from '../models/client.model.js';

export async function listClients(organizationId: string) {
  return prisma.client.findMany({
    where: { organizationId },
    include: { domains: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createClient(organizationId: string, input: CreateClientRequest) {
  return prisma.client.create({
    data: {
      organizationId,
      name: input.name,
      slug: input.slug,
    },
  });
}

export async function listDomains(organizationId: string, clientId?: string) {
  return prisma.domain.findMany({
    where: {
      client: { organizationId },
      ...(clientId ? { clientId } : {}),
    },
    include: { client: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Raised when a name is already held by another workspace.
 *
 * A separate error because the response is not a generic failure. "This domain is
 * already monitored by another workspace" is the whole answer, and returning a bare
 * conflict would leave the operator guessing whether they mistyped or whether
 * something is wrong.
 */
export class DomainNameTakenError extends Error {
  readonly code = 'DOMAIN_ALREADY_MONITORED';
  readonly status = 409;

  constructor(public readonly domainName: string) {
    super(
      `${domainName} is already monitored by another workspace. Remove it there first, or ask them to release it.`,
    );
    this.name = 'DomainNameTakenError';
  }
}

export interface CreateDomainOutcome {
  domain: Awaited<ReturnType<typeof prisma.domain.findUnique>>;
  /** False when this name was already held by this client and nothing was created. */
  created: boolean;
}

export async function createDomain(
  organizationId: string,
  clientId: string,
  input: CreateDomainRequest,
): Promise<CreateDomainOutcome | null> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: { id: true },
  });

  if (!client) {
    return null;
  }

  /**
   * Lowercased, because a DNS name is case-insensitive and the unique constraint
   * is plain rather than on `lower(name)`.
   *
   * Report routing already compared names without case, so `Example.com` and
   * `example.com` used to resolve to the same domain and were two rows. Storing one
   * canonical form is what lets the database enforce what the routing layer
   * assumed.
   */
  const name = normalizeDomain(input.name).toLowerCase();

  /**
   * Refused up front, with an explanation.
   *
   * Without this the collision was accepted, both rows reached VERIFIED, and report
   * routing then found two domains for one name and returned `ambiguous_domain` —
   * at which point *neither* workspace received another report for that domain and
   * nothing on either dashboard said why. One tenant naming a domain another
   * tenant monitors was enough to silently blind them.
   */
  const existing = await prisma.domain.findUnique({ where: { name }, select: { id: true, clientId: true } });

  if (existing && existing.clientId !== clientId) {
    throw new DomainNameTakenError(name);
  }

  if (existing) {
    // Already held by this client. Returning the same row is what stops a second one
    // being created, which is the state that used to make routing ambiguous inside a
    // single workspace too.
    return { domain: await prisma.domain.findUnique({ where: { id: existing.id } }), created: false };
  }

  return {
    domain: await prisma.domain.create({
      data: {
        clientId,
        name,
        slug: domainSlug(name),
      },
    }),
    created: true,
  };
}

/**
 * Resolves a domain by either identifier.
 *
 * Accepts the slug as well as the cuid so a URL can carry the slug while internal
 * callers, existing links and webhook payloads keep using the id. Guessing wrong
 * here would either break every stored id or force a migration of links we do
 * not control.
 */
export async function getDomain(organizationId: string, domainIdOrSlug: string) {
  return prisma.domain.findFirst({
    where: {
      client: { organizationId },
      OR: [{ id: domainIdOrSlug }, { slug: domainIdOrSlug }],
    },
    include: { client: true },
  });
}

export interface OwnershipCheckResult {
  verified: boolean;
  lookupStatus: string;
  error?: string;
  host: string;
  type: 'TXT';
  value: string;
}

/**
 * Reads the ownership TXT record and compares it to the expected value.
 *
 * Kept separate from the HTTP route so the same check can run on demand from
 * the interface, from an integration calling the API, and from the background
 * re-verification pass. One implementation means all three can never disagree
 * about whether a domain is owned.
 */
export async function checkDomainOwnership(domain: {
  name: string;
  verificationToken: string;
}): Promise<OwnershipCheckResult> {
  const host = `_dmarc-harbor-verification.${domain.name}`;
  const expectedValue = `dmarc-harbor-verification=${domain.verificationToken}`;
  const lookup = await systemDnsReader.resolveTxt(host);
  const verified = lookup.status === 'found' && lookup.value?.some((chunks) => chunks.join('') === expectedValue) === true;

  return {
    verified,
    lookupStatus: lookup.status,
    ...(lookup.error ? { error: lookup.error } : {}),
    host,
    type: 'TXT',
    value: expectedValue,
  };
}

/**
 * Applies an ownership result to a domain and emits domain.verified on the
 * transition only, so a re-check of an already verified domain is silent and
 * an integration is not trained to ignore the event.
 */
export async function applyOwnershipResult(
  organizationId: string,
  domain: { id: string; name: string; clientId: string; status: string; verificationToken: string },
  check: OwnershipCheckResult,
  now = new Date(),
): Promise<'VERIFIED' | 'FAILED' | 'PENDING'> {
  const alreadyVerified = domain.status === 'VERIFIED';

  if (check.verified) {
    if (!alreadyVerified) {
      await emitEvent(organizationId, 'domain.verified', {
        domainId: domain.id,
        domainName: domain.name,
        clientId: domain.clientId,
        verifiedAt: now.toISOString(),
        source: 'background',
      });
    }
    await prisma.domain.update({ where: { id: domain.id }, data: { status: 'VERIFIED', verifiedAt: now } });

    // Only on the transition. The background job re-checks a verified domain
    // daily, and mailing the owner every time would be noise, not news.
    if (!alreadyVerified) {
      void sendDomainVerificationEmail({ organizationId, domainId: domain.id, verified: true });
    }
    return 'VERIFIED';
  }

  if (check.lookupStatus === 'missing' && alreadyVerified) {
    await prisma.domain.update({ where: { id: domain.id }, data: { status: 'FAILED', verifiedAt: null } });

    // A lapsed proof is urgent, because reports for this domain are now being
    // rejected and the customer has a reporting gap they may not notice.
    void sendDomainVerificationEmail({ organizationId, domainId: domain.id, verified: false });
    return 'FAILED';
  }

  if (check.lookupStatus === 'missing' || check.lookupStatus === 'nxdomain') {
    return 'PENDING';
  }

  return domain.status === 'VERIFIED' ? 'VERIFIED' : 'PENDING';
}

export async function verifyDomain(organizationId: string, domainId: string) {
  const domain = await getDomain(organizationId, domainId);

  if (!domain) {
    return null;
  }

  const verification = await checkDomainOwnership(domain);
  const status = await applyOwnershipResult(organizationId, domain, verification);

  const updated = await prisma.domain.findUniqueOrThrow({
    where: { id: domain.id },
    include: { client: true },
  });

  return { domain: updated, verification: { ...verification, status } };
}
