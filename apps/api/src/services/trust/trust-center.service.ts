import { randomBytes } from 'node:crypto';
import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { planCatalog } from '../entitlements/plan-catalog.js';

/**
 * The client facing Trust Center.
 *
 * An enterprise auditor asks their MSP where their DMARC data is held and who
 * can read it. The honest answer today is a PDF attachment or a support ticket.
 * This is a public page at a stable, unguessable address, so the link can be
 * forwarded to somebody who has never heard of us and will not create an
 * account.
 *
 * The whole feature rests on one property: this function may only ever read
 * rows belonging to a single client. Every query below is anchored on the
 * client resolved from the slug, never on the workspace, because an agency
 * holds many clients and a mistake here publishes one customer's data on another
 * customer's page. The isolation suite proves it, and the leak test in the Trust
 * Center suite proves it again from the public side.
 *
 * The slug is random rather than a path segment like the client name, because
 * an enumerable Trust Center would disclose which clients an agency serves.
 */

export class TrustCenterError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'TRUST_CENTER_ERROR', status = 400) {
    super(message);
    this.name = 'TrustCenterError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Sub processors this product actually sends data to.
 *
 * Held as data rather than left in the published document, so the page cannot
 * quietly drift from the document an agency's clients were sent. A Trust Center
 * that names a different set of processors than the signed document is worse
 * than no Trust Center at all.
 */
export const subProcessors: { name: string; purpose: string; data: string }[] = [
  { name: 'PostgreSQL hosting', purpose: 'Primary database, including report records', data: 'Client identifiers, DMARC report metadata' },
  { name: 'Resend', purpose: 'Transactional email, such as alerts and digests', data: 'Recipient email addresses' },
  { name: 'Razorpay or Paddle', purpose: 'Subscription billing', data: 'Workspace name, billing contact, transaction reference' },
  { name: 'Cloudflare', purpose: 'DNS lookups and email routing for report collection', data: 'Queried domain names' },
];

/** Retention is quoted from the plan actually in force, not from marketing copy. */
function retentionFor(plan: keyof typeof planCatalog): { data: string; audit: string } {
  const definition = planCatalog[plan];
  return {
    data: `${definition.dataRetentionDays} days`,
    audit: `${definition.auditRetentionDays} days`,
  };
}

export interface TrustCenterPayload {
  generatedAt: string;
  client: { name: string; domains: string[] };
  provider: { workspaceName: string };
  statement: {
    isolation: string;
    coveredByTests: string;
    lawEnforcementRequests: string;
  };
  dataHeld: { category: string; description: string; containsPersonalData: boolean }[];
  access: { role: string; canRead: string }[];
  retention: { data: string; audit: string; deletionWindow: string };
  residency: { region: string; hosting: string };
  subProcessors: { name: string; purpose: string; data: string }[];
  rights: { export: string; erasure: string };
  erasures: { scope: string; completedAt: string; recordCount: number }[];
}

/**
 * Creates the public slug if the client does not have one.
 *
 * Idempotent, because calling it twice must not invalidate a link that has
 * already been shared with an auditor.
 */
export async function ensureTrustSlug(clientId: string, actorUserId?: string | null): Promise<string> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, trustSlug: true },
  });

  if (!client) {
    throw new TrustCenterError('That client does not exist.', 'CLIENT_NOT_FOUND', 404);
  }

  if (client.trustSlug) {
    return client.trustSlug;
  }

  const slug = randomBytes(24).toString('base64url');

  try {
    await prisma.client.update({ where: { id: clientId }, data: { trustSlug: slug } });
  } catch (error) {
    // A collision on 192 bits of entropy is not something to expect, but a
    // retry is cheaper than a failure the agency cannot act on.
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002') {
      return ensureTrustSlug(clientId, actorUserId);
    }
    throw error;
  }

  await recordAuditEvent({
    organizationId: (await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { organizationId: true } })).organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'TRUST_CENTER_CREATED',
    targetType: 'client',
    targetId: clientId,
    detail: { slug },
  });

  return slug;
}

/**
 * Withdraws the public link.
 *
 * Revocation is the point: an agency that stops working with a client must be
 * able to pull the page, and a page that has been shared cannot be recalled.
 */
export async function revokeTrustSlug(clientId: string, actorUserId?: string | null): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, organizationId: true, trustSlug: true },
  });

  if (!client) {
    throw new TrustCenterError('That client does not exist.', 'CLIENT_NOT_FOUND', 404);
  }

  await prisma.client.update({ where: { id: clientId }, data: { trustSlug: null } });

  await recordAuditEvent({
    organizationId: client.organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'TRUST_CENTER_REVOKED',
    targetType: 'client',
    targetId: clientId,
    detail: { previousSlug: client.trustSlug },
  });
}

/**
 * Builds the public payload for one client.
 *
 * Every query is anchored on the client resolved from the slug. Nothing here is
 * filtered by the workspace, because a workspace holds many clients and the
 * failure mode is publishing one client's data on another's page.
 */
export async function buildTrustCenter(slug: string): Promise<TrustCenterPayload> {
  const client = await prisma.client.findUnique({
    where: { trustSlug: slug },
    select: {
      id: true,
      name: true,
      organizationId: true,
      organization: { select: { name: true, plan: true } },
    },
  });

  if (!client) {
    // The same response for a missing slug and a withdrawn one, so the endpoint
    // does not confirm that a client ever had a Trust Center.
    throw new TrustCenterError('No Trust Center at this address.', 'TRUST_CENTER_NOT_FOUND', 404);
  }

  const entitlements = await resolveEntitlements(client.organizationId);

  // Scoped to the client id, never the workspace.
  const [domains, grants, erasures] = await Promise.all([
    prisma.domain.findMany({
      where: { clientId: client.id },
      select: { name: true },
      orderBy: { name: 'asc' },
      take: 200,
    }),
    prisma.clientPortalAccess.findMany({
      where: { clientId: client.id, revokedAt: null },
      select: { displayName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.erasureRequest.findMany({
      where: { organizationId: client.organizationId, state: 'COMPLETED', scope: { in: ['ORGANIZATION', 'CLIENT'] } },
      select: { id: true, scope: true, targetId: true, completedAt: true },
      orderBy: { completedAt: 'desc' },
      take: 20,
    }),
  ]);

  const retention = retentionFor(client.organization.plan);

  // Only the erasure requests that actually covered this client. An
  // organization wide deletion covered it too, so both are relevant and
  // anything else is not.
  const relevantErasures = (
    await Promise.all(
      erasures
        .filter((request) => request.scope === 'ORGANIZATION' || request.targetId === client.id)
        .map(async (request) => ({
          scope: request.scope === 'ORGANIZATION' ? 'whole workspace' : 'client',
          completedAt: request.completedAt?.toISOString() ?? '',
          recordCount: await deletedCountFor(request.id),
        })),
    )
  );

  return {
    generatedAt: new Date().toISOString(),
    client: { name: client.name, domains: domains.map((domain) => domain.name) },
    provider: { workspaceName: client.organization.name },
    statement: {
      isolation:
        'Records for this client are stored under a tenant boundary keyed to this client. No other client of the same provider, and no other provider using this platform, can read them. Access is checked on every request, not only at sign in.',
      coveredByTests:
        'The boundary is covered by an automated suite that attempts to reach this client from a second, unrelated workspace and asserts every attempt is refused.',
      lawEnforcementRequests:
        'A valid legal process is the only circumstance in which data for this client is disclosed outside the provider who manages it. Any such request is recorded in the audit trail.',
    },
    dataHeld: [
      { category: 'DMARC aggregate reports', description: 'Volume, authentication results and sending source counts per reporting period.', containsPersonalData: false },
      { category: 'Domain and DNS records', description: 'Domain names, DMARC policy, and the ownership record used to prove control.', containsPersonalData: false },
      { category: 'Scans', description: 'SPF, DKIM and MX results captured when a domain is added or re-checked.', containsPersonalData: false },
      { category: 'Forensic reports', description: 'Per message source detail including sending IP addresses.', containsPersonalData: Boolean(entitlements.features['reports.forensicNamed']) },
      { category: 'Named recipients', description: 'Individual recipients, collected only on plans that include it. Never shown to portal contacts.', containsPersonalData: Boolean(entitlements.features['reports.forensicNamed']) },
      { category: 'Account and billing records', description: 'Workspace members, portal grants and payment history.', containsPersonalData: true },
    ],
    access: [
      { role: 'Workspace owner and admin', canRead: 'Everything held for this client' },
      { role: 'Workspace member', canRead: 'Everything held for this client' },
      ...grants.map((grant) => ({
        role: grant.displayName ? `Portal contact (${grant.displayName})` : 'Portal contact',
        canRead: 'Report volume, sending sources and spoofing warnings. No forensic data, no named recipients.',
      })),
    ],
    retention: {
      data: retention.data,
      audit: retention.audit,
      deletionWindow: '7 days between requesting deletion and it running',
    },
    residency: {
      region: 'As configured for the provider account',
      hosting: 'Managed PostgreSQL and object storage, in the region above',
    },
    subProcessors,
    rights: {
      export: 'A machine readable export of everything held can be requested at any time, and is available on every plan including the free one.',
      erasure: 'Deletion can be requested for this client, the workspace, or a single domain. A certificate proving what was removed is retained.',
    },
    erasures: relevantErasures,
  };
}

/**
 * Reads the record count out of a stored certificate.
 *
 * Counted from the certificate rather than recomputed, because the records it
 * describes no longer exist, which is the entire point of the artifact.
 */
async function deletedCountFor(erasureRequestId: string): Promise<number> {
  const row = await prisma.erasureRequest.findUnique({
    where: { id: erasureRequestId },
    select: { certificate: true },
  });

  const certificate = row?.certificate;
  if (typeof certificate !== 'object' || certificate === null || !('deleted' in certificate)) {
    return 0;
  }

  const deleted = (certificate as { deleted?: Record<string, number> }).deleted;
  if (typeof deleted !== 'object' || deleted === null) {
    return 0;
  }

  return Object.values(deleted).reduce((total, value) => (typeof value === 'number' ? total + value : total), 0);
}

/** Lets the agency see the link for one client, or that there is none. */
export async function trustSlugStatus(clientId: string): Promise<{ url: string | null; slug: string | null }> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { trustSlug: true } });
  if (!client) {
    throw new TrustCenterError('That client does not exist.', 'CLIENT_NOT_FOUND', 404);
  }
  return { slug: client.trustSlug, url: client.trustSlug ? `/trust/${client.trustSlug}` : null };
}
